#!/usr/bin/env node
// One-time migration: Monday CRM connections moved from one per workspace
// (row key provider = "monday") to one per agent ("monday#<agentId>").
//
// Each legacy row moves to its workspace's oldest active agent. It is not
// copied to every agent: Monday rotates the refresh token on each use, so two
// rows sharing one grant would lock each other out. Other agents connect
// their own Monday account. Caller links ("monday#<phone>") move with it, and
// that agent's calls tagged with the old key are retagged.
//
//   node scripts/migrate-crm-per-agent.mjs            # dry run (default)
//   node scripts/migrate-crm-per-agent.mjs --apply    # write changes
//
// Uses the AWS CLI (same credentials/region as Terraform). Table names
// default to the symantic-dev stack; override with CRM_CONNECTIONS_TABLE,
// CRM_LINKS_TABLE, AGENTS_TABLE, CALLS_TABLE.

import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const tables = {
  connections: process.env.CRM_CONNECTIONS_TABLE ?? "symantic-dev-crm-connections",
  links: process.env.CRM_LINKS_TABLE ?? "symantic-dev-crm-links",
  agents: process.env.AGENTS_TABLE ?? "symantic-dev-agents",
  calls: process.env.CALLS_TABLE ?? "symantic-dev-calls",
};

function aws(args) {
  const result = spawnSync("aws", [...args, "--output", "json"], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  if (result.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : {};
}

// Minimal DynamoDB JSON <-> plain value conversion (S, N, BOOL, NULL, M, L).
function fromDynamo(value) {
  if ("S" in value) return value.S;
  if ("N" in value) return Number(value.N);
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("M" in value) return Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, fromDynamo(v)]));
  if ("L" in value) return value.L.map(fromDynamo);
  throw new Error(`Unsupported DynamoDB type: ${Object.keys(value)}`);
}
const unmarshall = (item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, fromDynamo(v)]));

function paged(command, args) {
  const items = [];
  let token;
  do {
    const page = aws(["dynamodb", command, ...args, ...(token ? ["--starting-token", token] : [])]);
    items.push(...(page.Items ?? []));
    token = page.NextToken;
  } while (token);
  return items;
}

const legacy = paged("scan", [
  "--table-name", tables.connections,
  "--filter-expression", "#p = :legacy",
  "--expression-attribute-names", JSON.stringify({ "#p": "provider" }),
  "--expression-attribute-values", JSON.stringify({ ":legacy": { S: "monday" } }),
]);
console.log(`${legacy.length} legacy Monday connection(s). ${apply ? "APPLYING" : "Dry run (pass --apply to write)"}.`);

for (const rawRow of legacy) {
  const row = unmarshall(rawRow);
  const agents = paged("query", [
    "--table-name", tables.agents,
    "--key-condition-expression", "workspaceId = :w",
    "--expression-attribute-values", JSON.stringify({ ":w": { S: row.workspaceId } }),
  ]).map(unmarshall).filter((agent) => agent.status !== "deleted")
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const agent = agents[0];
  if (!agent) {
    console.log(`- ${row.workspaceId}: no active agent; leaving the legacy row alone.`);
    continue;
  }
  const key = `monday#${agent.agentId}`;
  const links = paged("query", [
    "--table-name", tables.links,
    "--key-condition-expression", "workspaceId = :w AND begins_with(linkKey, :p)",
    "--expression-attribute-values", JSON.stringify({ ":w": { S: row.workspaceId }, ":p": { S: "monday#+" } }),
  ]);
  const calls = paged("query", [
    "--table-name", tables.calls,
    "--key-condition-expression", "workspaceId = :w",
    "--filter-expression", "crmProvider = :legacy AND agentId = :a",
    "--projection-expression", "workspaceId, callId",
    "--expression-attribute-values", JSON.stringify({ ":w": { S: row.workspaceId }, ":legacy": { S: "monday" }, ":a": { S: agent.agentId } }),
  ]);
  console.log(`- ${row.workspaceId} (${row.accountName ?? "Monday"}) -> agent "${agent.name ?? agent.agentId}" [${key}]: ${links.length} caller link(s), ${calls.length} call(s) to retag.`);
  if (!apply) continue;

  // Raw DynamoDB JSON is copied as-is (encrypted tokens included).
  aws(["dynamodb", "put-item",
    "--table-name", tables.connections,
    "--item", JSON.stringify({ ...rawRow, provider: { S: key }, agentId: { S: agent.agentId } }),
    "--condition-expression", "attribute_not_exists(workspaceId)"]);
  for (const link of links) {
    const oldKey = link.linkKey.S;
    aws(["dynamodb", "put-item", "--table-name", tables.links,
      "--item", JSON.stringify({ ...link, linkKey: { S: `${key}#${oldKey.slice("monday#".length)}` } })]);
    aws(["dynamodb", "delete-item", "--table-name", tables.links,
      "--key", JSON.stringify({ workspaceId: link.workspaceId, linkKey: link.linkKey })]);
  }
  for (const call of calls) {
    aws(["dynamodb", "update-item", "--table-name", tables.calls,
      "--key", JSON.stringify({ workspaceId: call.workspaceId, callId: call.callId }),
      "--update-expression", "SET crmProvider = :k",
      "--expression-attribute-values", JSON.stringify({ ":k": { S: key } })]);
  }
  aws(["dynamodb", "delete-item", "--table-name", tables.connections,
    "--key", JSON.stringify({ workspaceId: { S: row.workspaceId }, provider: { S: "monday" } })]);
  console.log("  moved.");
}
