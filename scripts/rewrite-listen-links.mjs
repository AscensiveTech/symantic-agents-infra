#!/usr/bin/env node
// One-time repair: Monday rows written before the fix link "Listen" to
// /calls/<id> (a 404). Queue a "rewrite-links" job for every call we wrote to
// Monday, for every connected agent; the sync worker updates each row's link
// in place (to Call History's pop-up for that call). Nothing is added.
//
//   node scripts/rewrite-listen-links.mjs            # dry run: counts only
//   node scripts/rewrite-listen-links.mjs --apply    # queue the jobs

import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");

function aws(args) {
  const r = spawnSync("aws", [...args, "--output", "json"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  if (r.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout) : {};
}

function all(command, args) {
  const items = [];
  let token;
  do {
    const page = aws(["dynamodb", command, ...args, ...(token ? ["--starting-token", token] : [])]);
    items.push(...(page.Items ?? []));
    token = page.NextToken;
  } while (token);
  return items;
}

// Connected agents only: a disconnected agent's rows can't be updated.
const connections = all("scan", [
  "--table-name", "symantic-dev-crm-connections",
  "--filter-expression", "connectionState = :c AND begins_with(#p, :m)",
  "--expression-attribute-names", JSON.stringify({ "#p": "provider" }),
  "--expression-attribute-values", JSON.stringify({ ":c": { S: "connected" }, ":m": { S: "monday#" } }),
  "--projection-expression", "workspaceId, #p",
]).map((row) => ({ workspaceId: row.workspaceId.S, key: row.provider.S, agentId: row.provider.S.split("#")[1] }));

const jobs = [];
for (const { workspaceId, key, agentId } of connections) {
  const calls = all("query", [
    "--table-name", "symantic-dev-calls",
    "--key-condition-expression", "workspaceId = :w",
    "--filter-expression", "agentId = :a AND (attribute_exists(crmCallsItemId) OR attribute_exists(crmItemId))",
    "--projection-expression", "callId",
    "--expression-attribute-values", JSON.stringify({ ":w": { S: workspaceId }, ":a": { S: agentId } }),
  ]);
  for (const call of calls) jobs.push({ v: 1, kind: "rewrite-links", workspaceId, callId: call.callId.S, provider: key });
  console.log(`- ${workspaceId} / ${key}: ${calls.length} call(s)`);
}
console.log(`${jobs.length} link rewrite(s). ${apply ? "QUEUEING" : "Dry run (add --apply)."}`);
if (apply) {
  const queueUrl = aws(["sqs", "get-queue-url", "--queue-name", "symantic-dev-crm-sync"]).QueueUrl;
  for (const job of jobs) aws(["sqs", "send-message", "--queue-url", queueUrl, "--message-body", JSON.stringify(job)]);
  console.log("Queued.");
}
