// Integration test: the real DynamoDB store (store.mjs) against the deployed
// tables. The flow tests use an in-memory twin; this proves the conditional
// expressions that twin imitates actually behave that way in DynamoDB.
//
// Run after `terraform apply`, with admin credentials:
//   AWS_PROFILE=ascensiveAdmin AWS_REGION=us-east-1 ENVIRONMENT=dev \
//     node --test lambda/crm/integration/dynamo-store.integration.mjs
//
// Uses a synthetic workspace id and deletes every row it writes.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import * as dynamodb from "@aws-sdk/client-dynamodb";

import { createDynamoCrmStore, linkKeyFor, marshall } from "../store.mjs";

const env = process.env.ENVIRONMENT ?? "dev";
const tables = {
  connections: `symantic-${env}-crm-connections`,
  links: `symantic-${env}-crm-links`,
  calls: `symantic-${env}-calls`,
  businessProfiles: `symantic-${env}-business-profiles`,
  memberships: `symantic-${env}-workspace-memberships`,
  oauthStates: `symantic-${env}-oauth-states`,
};
const client = new dynamodb.DynamoDBClient({});
const store = createDynamoCrmStore(client, dynamodb, tables);
const workspaceId = `crm-it-${randomUUID()}`;
const otherWorkspaceId = `crm-it-${randomUUID()}`;
const accountId = `it-${randomUUID()}`;
const cleanup = [];

function track(table, key) {
  cleanup.push({ table, key });
}

after(async () => {
  for (const { table, key } of cleanup) {
    await client.send(new dynamodb.DeleteItemCommand({ TableName: table, Key: marshall(key) })).catch(() => {});
  }
});

test("authorization, refresh lock and token CAS behave atomically", async () => {
  track(tables.connections, { workspaceId, provider: "monday" });
  const first = await store.saveAuthorization(workspaceId, "monday", {
    accountId,
    encryptedAccessToken: "a1",
    encryptedRefreshToken: "r1",
    accessTokenExpiresAt: 1,
    refreshTokenExpiresAt: Date.now() + 1e9,
  });
  assert.equal(first.tokenVersion, 1);
  assert.equal(first.connectionState, "connected");
  assert.equal(first.mappingStatus, "unconfigured");

  assert.equal(await store.acquireRefreshLock(workspaceId, "monday", 1, Date.now() + 15_000), true);
  assert.equal(await store.acquireRefreshLock(workspaceId, "monday", 1, Date.now() + 15_000), false, "lock held");
  assert.equal(await store.acquireRefreshLock(workspaceId, "monday", 99, Date.now() + 15_000), false, "wrong version");

  const saved = await store.saveRefreshedTokens({
    workspaceId,
    provider: "monday",
    expectedVersion: 1,
    encryptedAccessToken: "a2",
    encryptedRefreshToken: "r2",
    accessTokenExpiresAt: 2,
    refreshTokenExpiresAt: 3,
  });
  assert.equal(saved.tokenVersion, 2);
  assert.equal(saved.refreshLockUntil, undefined, "lock released with the write");
  assert.equal(await store.saveRefreshedTokens({
    workspaceId, provider: "monday", expectedVersion: 1, encryptedAccessToken: "x", encryptedRefreshToken: "x",
    accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0,
  }), null, "a stale writer loses the compare-and-swap");

  const reauth = await store.markReauthRequired(workspaceId, "monday", "refresh_rejected");
  assert.equal(reauth.connectionState, "reauth_required");
  assert.equal(await store.markReauthRequired(workspaceId, "monday", "again"), null, "only from connected");

  await store.saveMapping(workspaceId, "monday", { boardId: "1", columns: { phone: { id: "p" } } }, { status: "valid", problems: [] });
  const reconnected = await store.saveAuthorization(workspaceId, "monday", {
    accountId,
    encryptedAccessToken: "a3",
    encryptedRefreshToken: "r3",
    accessTokenExpiresAt: 4,
    refreshTokenExpiresAt: 5,
  });
  assert.equal(reconnected.tokenVersion, 3);
  assert.equal(reconnected.connectionState, "connected");
  assert.equal(reconnected.reauthReason, undefined);
  assert.equal(reconnected.mapping.boardId, "1", "reconnecting keeps the mapping");

  const disconnected = await store.disconnect(workspaceId, "monday", "user_disconnected");
  assert.equal(disconnected.connectionState, "disconnected");
  assert.equal(disconnected.encryptedRefreshToken, undefined);
  assert.equal(disconnected.encryptedAccessToken, undefined);
});

test("the accountId index finds connections for the uninstall webhook, without tokens", async () => {
  track(tables.connections, { workspaceId: otherWorkspaceId, provider: "monday" });
  await store.saveAuthorization(otherWorkspaceId, "monday", {
    accountId,
    encryptedAccessToken: "secret-a",
    encryptedRefreshToken: "secret-r",
    accessTokenExpiresAt: 1,
    refreshTokenExpiresAt: 2,
  });
  let found = [];
  for (let attempt = 0; attempt < 10 && found.length < 2; attempt += 1) {
    found = await store.listConnectionsByAccount("monday", accountId);
    if (found.length < 2) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(found.map((row) => row.workspaceId).sort(), [workspaceId, otherWorkspaceId].sort());
  assert.ok(found.every((row) => row.encryptedRefreshToken === undefined), "no token material in the index");
});

test("per-phone leases exclude other owners until released or expired", async () => {
  const linkKey = linkKeyFor("monday", "+15550000001");
  track(tables.links, { workspaceId, linkKey });
  assert.ok(await store.acquireLinkLease(workspaceId, linkKey, "call-a", Date.now() + 60_000));
  assert.equal(await store.acquireLinkLease(workspaceId, linkKey, "call-b", Date.now() + 60_000), null);
  assert.ok(await store.acquireLinkLease(workspaceId, linkKey, "call-a", Date.now() + 60_000), "re-entrant");
  assert.equal(await store.releaseLinkLease(workspaceId, linkKey, "call-b"), null, "only the owner releases");
  await store.releaseLinkLease(workspaceId, linkKey, "call-a");
  assert.ok(await store.acquireLinkLease(workspaceId, linkKey, "call-b", Date.now() - 1), "free after release");
  assert.ok(await store.acquireLinkLease(workspaceId, linkKey, "call-c", Date.now() + 60_000), "expired lease is taken over");
});

test("links save, clear with null, and only move their watermark forward", async () => {
  const linkKey = linkKeyFor("monday", "+15550000002");
  track(tables.links, { workspaceId, linkKey });
  let link = await store.saveLink(workspaceId, linkKey, { state: "linked", externalId: "123", boardId: "1" });
  assert.equal(link.externalId, "123");
  link = await store.saveLink(workspaceId, linkKey, { state: "none", externalId: null, boardId: "1" });
  assert.equal(link.externalId, undefined, "null removes the attribute");
  assert.ok(await store.advanceWatermark(workspaceId, linkKey, "2026-09-25T14:00:00.000Z", { appointmentAt: "x" }));
  assert.equal(await store.advanceWatermark(workspaceId, linkKey, "2026-09-25T10:00:00.000Z"), null, "older call rejected");
  assert.equal(await store.advanceWatermark(workspaceId, linkKey, "2026-09-25T14:00:00.000Z"), null, "same call rejected");
  const newer = await store.advanceWatermark(workspaceId, linkKey, "2026-09-25T15:00:00.000Z", { appointmentAt: null });
  assert.equal(newer.appointmentAt, undefined);
});

test("call sync state: re-arming skips synced calls; failed calls are listed for retry", async () => {
  const callId = `call-it-${randomUUID()}`;
  track(tables.calls, { workspaceId, callId });
  assert.equal(await store.markCallQueued(workspaceId, callId, "monday"), false, "no such call");
  await client.send(new dynamodb.PutItemCommand({
    TableName: tables.calls,
    Item: marshall({ workspaceId, callId, analyzedAt: new Date().toISOString() }),
  }));
  assert.equal(await store.markCallQueued(workspaceId, callId, "monday"), true);
  await store.updateCallSync(workspaceId, callId, { crmStatus: "failed", crmLastErrorCode: "mapping_invalid", crmItemId: "9" });
  const failed = await store.listFailedCalls(workspaceId, new Date(Date.now() - 86_400_000).toISOString());
  assert.deepEqual(failed.map((row) => row.callId), [callId]);
  const cleared = await store.updateCallSync(workspaceId, callId, { crmStatus: "synced", crmItemId: null });
  assert.equal(cleared.crmItemId, undefined);
  assert.equal(await store.markCallQueued(workspaceId, callId, "monday"), false, "synced calls stay synced");
  assert.equal(await store.updateCallSync(otherWorkspaceId, callId, { crmStatus: "failed" }), null, "keyed by workspace");
});

test("OAuth state is single-use", async () => {
  const state = `it-${randomUUID()}`;
  await store.putOAuthState({ state, provider: "monday-crm", workspaceId, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  assert.equal((await store.consumeOAuthState(state)).workspaceId, workspaceId);
  assert.equal(await store.consumeOAuthState(state), null);
});
