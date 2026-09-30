#!/usr/bin/env node
// One-time: queue an agent's past calls through the normal CRM sync, so each
// gets a row on that agent's "Symantic AI Calls" Monday board. Refuses to run
// unless the agent's connection is to the expected Monday account.
//
//   node scripts/backfill-agent-calls-to-monday.mjs --workspace W --agent A --account "Name"          # dry run
//   node scripts/backfill-agent-calls-to-monday.mjs --workspace W --agent A --account "Name" --apply

import { spawnSync } from "node:child_process";

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const apply = process.argv.includes("--apply");
const [workspaceId, agentId, account] = [arg("--workspace"), arg("--agent"), arg("--account")];
if (!workspaceId || !agentId || !account) throw new Error("--workspace, --agent and --account are required");
const key = `monday#${agentId}`;

function aws(args) {
  const r = spawnSync("aws", [...args, "--output", "json"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  if (r.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : {};
}

const conn = aws(["dynamodb", "get-item", "--table-name", "symantic-dev-crm-connections",
  "--key", JSON.stringify({ workspaceId: { S: workspaceId }, provider: { S: key } })]).Item;
if (conn?.accountName?.S !== account || conn?.connectionState?.S !== "connected") {
  throw new Error(`Stopping: ${key} is ${conn ? `"${conn.accountName?.S}" (${conn.connectionState?.S})` : "not connected"}, not "${account}".`);
}

const calls = [];
let token;
do {
  const page = aws(["dynamodb", "query", "--table-name", "symantic-dev-calls",
    "--key-condition-expression", "workspaceId = :w",
    "--filter-expression", "agentId = :a AND attribute_exists(callerNumber) AND (attribute_not_exists(crmStatus) OR crmStatus <> :synced) AND (attribute_not_exists(demoSeed) OR demoSeed = :f)",
    "--projection-expression", "callId",
    "--expression-attribute-values", JSON.stringify({ ":w": { S: workspaceId }, ":a": { S: agentId }, ":synced": { S: "synced" }, ":f": { BOOL: false } }),
    ...(token ? ["--starting-token", token] : [])]);
  calls.push(...(page.Items ?? []).map((item) => item.callId.S));
  token = page.NextToken;
} while (token);

console.log(`Account "${account}" verified for ${key}. ${calls.length} past call(s) to log. ${apply ? "APPLYING" : "Dry run (add --apply)."}`);
if (!apply) process.exit(0);

const queueUrl = aws(["sqs", "get-queue-url", "--queue-name", "symantic-dev-crm-sync"]).QueueUrl;
let queued = 0;
for (const callId of calls) {
  aws(["dynamodb", "update-item", "--table-name", "symantic-dev-calls",
    "--key", JSON.stringify({ workspaceId: { S: workspaceId }, callId: { S: callId } }),
    "--update-expression", "SET crmStatus = :p, crmProvider = :k",
    "--condition-expression", "attribute_not_exists(crmStatus) OR crmStatus <> :synced",
    "--expression-attribute-values", JSON.stringify({ ":p": { S: "pending" }, ":k": { S: key }, ":synced": { S: "synced" } })]);
  aws(["sqs", "send-message", "--queue-url", queueUrl, "--message-body", JSON.stringify({ v: 1, workspaceId, callId, provider: key })]);
  queued += 1;
}
console.log(`Queued ${queued} call(s); the sync worker logs them to the Symantic AI Calls board.`);
