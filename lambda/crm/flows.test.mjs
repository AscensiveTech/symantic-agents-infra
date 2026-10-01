import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_CRM_CONTEXT } from "./context.mjs";
import { createHandler } from "./index.mjs";
import { boardLinkKeyFor, linkKeyFor } from "./store.mjs";
import { signJwt, TEST_APP_SECRET } from "./test-support/fakes.mjs";
import { APP_URL, createHarness, toolLogFor } from "./test-support/harness.mjs";

const body = (response) => JSON.parse(response.body);

// ============================================================ connection ====

test("connect: OAuth round trip stores encrypted tokens and never exposes them", async () => {
  const h = createHarness();
  const { url, callback } = await h.connect();
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example.test/crm/oauth/monday/callback");
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, `${APP_URL}/integrations?crm=connected`);

  const row = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(row.connectionState, "connected");
  assert.equal(row.accountId, "5550001");
  assert.equal(row.mappingStatus, "unconfigured");
  assert.ok(!row.encryptedAccessToken.startsWith("acc."), "access token is stored encrypted");
  assert.ok(!row.encryptedRefreshToken.startsWith("ref-"), "refresh token is stored encrypted");

  const view = await h.api("GET", "/crm/connection", { sub: "sub-member-a", groups: [] });
  const text = view.body;
  assert.equal(body(view).connectionState, "connected");
  assert.equal(body(view).accountName, "Acme Dental");
  assert.ok(body(view).reauthorizeBy, "the six-month re-authorization date is shown");
  assert.ok(!/encrypted|acc\.|ref-/.test(text), "no token material in the API response");
  assert.equal(h.metrics.sum("OAuth", { Outcome: "connected" }), 1);
});

test("connect: only workspace admins can start, and only signed-in members can read", async () => {
  const h = createHarness();
  assert.equal((await h.api("GET", "/crm/monday/setup", { sub: "sub-member-a", groups: [] })).statusCode, 403);
  assert.equal((await h.api("POST", "/crm/monday/start", { sub: "sub-member-a", groups: [] })).statusCode, 403);
  assert.equal((await h.api("POST", "/crm/monday/start", {})).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", {})).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", { sub: "sub-disabled" })).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", { sub: "sub-unknown" })).statusCode, 401);
  assert.equal((await h.api("DELETE", "/crm/connection", { sub: "sub-member-a", groups: [] })).statusCode, 403);
  assert.equal((await h.api("PUT", "/crm/mapping", { sub: "sub-member-a", groups: [], body: {} })).statusCode, 403);
});

test("connect: a customer admin receives the public app installation URL", async () => {
  const h = createHarness();
  const setup = body(await h.api("GET", "/crm/monday/setup", { sub: "sub-admin-a" }));
  const url = new URL(setup.installUrl);
  assert.equal(url.searchParams.get("client_id"), TEST_APP_SECRET.clientId);
  assert.equal(url.searchParams.get("response_type"), "install");
});

test("connect: a missing app registration fails clearly instead of half-connecting", async () => {
  const h = createHarness({ secret: {} });
  const start = await h.api("POST", "/crm/monday/start", { sub: "sub-admin-a" });
  assert.equal(start.statusCode, 503);
  assert.equal(body(start).error, "provider_not_configured");
});

test("OAuth failure: denied consent, bad state, replayed state and bad code all land on an error redirect", async () => {
  const h = createHarness();
  const start = body(await h.api("POST", "/crm/monday/start", { sub: "sub-admin-a", body: { returnTo: "/integrations" } }));
  const state = new URL(start.authorizeUrl).searchParams.get("state");

  const denied = await h.api("GET", "/crm/oauth/monday/callback", { query: { state, error: "access_denied" } });
  assert.match(denied.headers.location, /crm=error&reason=authorization_denied/);

  const replay = await h.api("GET", "/crm/oauth/monday/callback", { query: { state, code: "x" } });
  assert.match(replay.headers.location, /reason=invalid_state/, "a state works once");

  const forged = await h.api("GET", "/crm/oauth/monday/callback", { query: { state: "forged", code: "x" } });
  assert.match(forged.headers.location, /reason=invalid_state/);

  const second = body(await h.api("POST", "/crm/monday/start", { sub: "sub-admin-a" }));
  const badCode = await h.api("GET", "/crm/oauth/monday/callback", {
    query: { state: new URL(second.authorizeUrl).searchParams.get("state"), code: "never-issued" },
  });
  assert.match(badCode.headers.location, /reason=connection_failed/);

  const third = body(await h.api("POST", "/crm/monday/start", { sub: "sub-admin-a" }));
  h.clock.advance(11 * 60 * 1000);
  const expired = await h.api("GET", "/crm/oauth/monday/callback", {
    query: { state: new URL(third.authorizeUrl).searchParams.get("state"), code: "x" },
  });
  assert.match(expired.headers.location, /reason=invalid_state/, "states expire after 10 minutes");
  assert.equal(h.store.connections.size, 0, "no connection is created by any failed attempt");
});

test("OAuth: returnTo cannot redirect off-site", async () => {
  const h = createHarness();
  const { callback } = await h.connect({ returnTo: "//evil.example/steal" });
  assert.equal(new URL(callback.headers.location).origin, APP_URL);
});

test("mapping: boards come with a suggestion; a valid mapping saves with live column types", async () => {
  const h = createHarness();
  await h.connect();
  const boards = body(await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-a" }));
  const leads = boards.boards.find((b) => b.id === h.board.id);
  assert.equal(leads.hasPhoneColumn, true);
  assert.equal(leads.suggestion.columns.phone.id, "phone_mkx1");
  assert.deepEqual(boards.users.map((u) => u.name), ["Sam Lee", "Priya Shah"]);

  const saved = await h.configureMapping({
    overrides: { columns: { ...leads.suggestion.columns, phone: { id: "phone_mkx1", type: "text" } } },
  });
  assert.equal(saved.statusCode, 200);
  const row = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(row.mappingStatus, "valid");
  assert.equal(row.mapping.columns.phone.type, "phone", "a client-supplied type is replaced by Monday's");
  assert.equal(row.mapping.boardName, "Leads");
});

test("disconnect: revokes at Monday, deletes our tokens, keeps the mapping for reconnect", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const response = await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).connectionState, "disconnected");
  assert.equal(h.monday.revoked.length, 1);
  const row = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(row.encryptedAccessToken, undefined);
  assert.equal(row.encryptedRefreshToken, undefined);
  assert.ok(row.mapping);

  h.monday.reset();
  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(lookup.status, "skipped");
  assert.equal(h.monday.graphqlCount(), 0, "a disconnected CRM costs zero Monday calls");
});

test("disconnect still succeeds when Monday's revoke endpoint is down", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("revoke");
  const response = await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(body(response).connectionState, "disconnected");
  assert.equal(h.monday.revoked.length, 0);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").encryptedRefreshToken, undefined);
});

test("reconnect after re-authorization keeps the mapping, revalidates it, and retries failed syncs", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.revokeAll();
  h.monday.expireAccessTokens();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "reauth_required");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "failed");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmLastErrorCode, "reauth_required");

  const view = body(await h.api("GET", "/crm/connection", { sub: "sub-admin-a" }));
  assert.equal(view.connectionState, "reauth_required");
  assert.equal(view.reauthorizeBy, null);

  const { callback } = await h.connect();
  assert.match(callback.headers.location, /crm=connected/);
  const row = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(row.connectionState, "connected");
  assert.equal(row.mappingStatus, "valid");
  // Reconnecting re-queued the failed call; the worker (run by connect())
  // has already synced it.
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

// ================================================================ lookup ====

test("lookup: an unknown caller gets no context and a remembered negative answer", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const result = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550111" });
  assert.equal(result.status, "not_found");
  assert.equal(result.context, NO_CRM_CONTEXT);
  assert.equal(h.store.links.get(`ws-a\0${boardLinkKeyFor("monday#agent-a", h.board.id, "+12025550111")}`).state, "none");
});

test("lookup: duplicate phone matches provide no context and cache no arbitrary record", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane One", phone: "+12025550198" });
  h.monday.addItem(h.board.id, { name: "Jane Two", phone: "+12025550198" });

  const result = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "duplicate_phone");
  assert.equal(result.context, NO_CRM_CONTEXT);
  const link = h.store.links.get(`ws-a\0${boardLinkKeyFor("monday#agent-a", h.board.id, "+12025550198")}`);
  assert.notEqual(link?.state, "linked");
  assert.equal(link?.externalId, undefined);
  assert.equal(h.metrics.sum("AmbiguousMatch", { Provider: "monday" }), 1);
});

test("lookup: a linked record deleted in Monday falls back to a phone search", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const old = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  h.monday.deleteItem(old.id);
  const replacement = h.monday.addItem(h.board.id, { name: "Jane (new)", phone: "+12025550198" });
  const result = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.match(result.context, /Jane \(new\)/);
  assert.equal(h.store.links.get(`ws-a\0${boardLinkKeyFor("monday#agent-a", h.board.id, "+12025550198")}`).externalId, replacement.id);
});

test("lookup: Monday slow, down, rate-limited or rejecting never throws and never blocks past the budget", async () => {
  const h = createHarness();
  await h.connectAndMap();

  h.monday.delay("search", 3000);
  const started = Date.now();
  const slow = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  const elapsed = Date.now() - started;
  h.monday.delay("search", 0);
  assert.equal(slow.status, "timeout");
  assert.equal(slow.context, NO_CRM_CONTEXT);
  assert.ok(elapsed < 1500, `lookup gave up after ${elapsed}ms`);

  h.monday.failNext("search", { status: 500, body: {} });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).status, "error");

  h.monday.failNext("search", { status: 429, body: h.monday.errorBody("Rate Limit Exceeded"), headers: { "retry-after": "30" } });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).status, "error");

  h.monday.failNext("search", { status: 200, body: h.monday.errorBody("InvalidColumnIdException") });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).status, "error");
  assert.ok(h.logs.every((entry) => !JSON.stringify(entry).includes("2025550198")), "logs never hold the full number");
});

test("lookup: hitting the daily API cap pauses the connection until the next UTC day", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("search", { status: 429, body: h.monday.errorBody("DAILY_LIMIT_EXCEEDED") });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).status, "error");
  const pausedUntil = h.store.connections.get("ws-a\0monday#agent-a").pausedUntil;
  assert.equal(new Date(pausedUntil).toISOString(), "2026-09-26T00:05:00.000Z");
  h.monday.reset();
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).reason, "paused");
  assert.equal(h.monday.graphqlCount(), 0, "no calls are spent while paused");
  h.clock.set(pausedUntil + 1000);
  h.monday.expireAccessTokens();
  assert.notEqual((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).reason, "paused");
});

test("lookup: an expired access token is refreshed transparently; a revoked grant flips to reauth", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  h.clock.advance(2 * 60 * 60 * 1000);
  const refreshed = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(refreshed.status, "found");
  assert.equal(h.monday.count("oauth_refresh_token"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").tokenVersion, 2);

  h.monday.revokeAll();
  h.clock.advance(2 * 60 * 60 * 1000);
  const revoked = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(revoked.status, "error");
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "reauth_required");
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).reason, "not_connected");
});

test("lookup: authorization past its six-month ceiling needs reconnecting", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.clock.advance(181 * 86_400_000);
  const result = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(result.context, NO_CRM_CONTEXT);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").reauthReason, "authorization_expired");
});

test("lookup via the Lambda handler (BFF invoke path) returns context and never throws", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const handler = createHandler({ getRuntime: async () => h.runtime });
  const result = await handler({ action: "lookup", workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(result.status, "found");
  const broken = createHandler({ getRuntime: async () => { throw new Error("no env"); } });
  assert.deepEqual(await broken({ action: "lookup", workspaceId: "ws-a" }), { status: "error", context: NO_CRM_CONTEXT });
  assert.equal((await handler({ foo: 1 })).statusCode, 400);
});

// ================================================================== sync ====

test("sync: spam, anonymous callers and unconnected workspaces are skipped without Monday calls", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const spam = h.seedCall({ outcome: "spam" });
  const anonymous = h.seedCall({ callerNumber: "anonymous" });
  const otherTenant = h.seedCall({ workspaceId: "ws-b" });
  for (const call of [spam, anonymous, otherTenant]) h.enqueueCall(call);
  await h.drain();
  assert.equal(h.monday.graphqlCount(), 0);
  assert.equal(h.store.callRows.get(`ws-a\0${spam.callId}`).crmStatus, "skipped");
  assert.equal(h.store.callRows.get(`ws-a\0${anonymous.callId}`).crmLastErrorCode, "no_caller_number");
  assert.equal(h.store.callRows.get(`ws-b\0${otherTenant.callId}`).crmStatus, "skipped");
});

// ==================================================== duplicate safety ====

test("duplicates: sync refuses to update an arbitrary phone match", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const first = h.monday.addItem(h.board.id, { name: "Jane One", phone: "+12025550198" });
  const second = h.monday.addItem(h.board.id, { name: "Jane Two", phone: "+12025550198" });
  const call = h.seedCall();
  h.enqueueCall(call);

  await h.drain();

  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "failed");
  assert.equal(row.crmLastErrorCode, "ambiguous_match");
  assert.equal(first.updates.length, 0);
  assert.equal(second.updates.length, 0);
  const link = h.store.links.get(`ws-a\0${boardLinkKeyFor("monday#agent-a", h.board.id, "+12025550198")}`);
  assert.notEqual(link?.state, "linked");
  assert.equal(link?.externalId, undefined);
  assert.equal(h.metrics.sum("AmbiguousMatch", { Provider: "monday" }), 1);
});

test("duplicates: a lost create_item response with the phone column unsearchable still replays via idempotency key", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.failNext("create_item", { afterEffect: true, status: 502 });
  // Simulate Monday's search index lagging behind the write.
  h.monday.failNext("search", { status: 200, body: { data: { items_page_by_column_values: { items: [] } } }, times: 3 });
  h.enqueueCall(call);
  await h.drain({ advanceMs: 60_000 });
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1, "no duplicate lead");
  assert.ok(h.monday.requests.some((r) => r.operation === "create_item" && r.replayed), "second create was a replay");
});

// ========================================================== retries/DLQ ====

test("retries: a 5xx then success syncs once, with backoff applied", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.failNext("search", { status: 503, body: {}, times: 2 });
  h.enqueueCall(call);
  const event = h.queue.receive();
  h.queue.settle(event, await h.worker(event));
  const message = h.queue.messages[0];
  assert.equal(message.visibleAt - h.clock(), 30_000, "first retry waits 30s");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "retrying");
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.equal(h.metrics.sum("SyncRetried", { Outcome: "transient" }), 2);
});

test("retries: a rate limit waits for Monday's retry_in_seconds", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.failNext("search", { status: 200, body: h.monday.errorBody("ComplexityException", "budget", { retry_in_seconds: 47 }) });
  h.enqueueCall(call);
  const event = h.queue.receive();
  h.queue.settle(event, await h.worker(event));
  assert.equal(h.queue.messages[0].visibleAt - h.clock(), 47_000);
  assert.equal(h.metrics.sum("RateLimited", { Outcome: "rate_limited" }), 1);
});

test("retries: the daily cap pauses sync until after UTC midnight, then resumes", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const first = h.seedCall();
  const second = h.seedCall({ callerNumber: "+13105550100" });
  h.monday.failNext("search", { status: 429, body: h.monday.errorBody("DAILY_LIMIT_EXCEEDED") });
  h.enqueueCall(first);
  h.enqueueCall(second);
  const event = h.queue.receive();
  h.queue.settle(event, await h.worker(event));
  const resumeAt = Date.parse("2026-09-26T00:05:00.000Z");
  assert.ok(h.queue.messages.every((m) => m.visibleAt >= resumeAt), "both messages wait for the reset");
  assert.equal(h.monday.graphqlCount(), 2, "the first call's log row and search; the second message spent nothing while paused");
  h.clock.set(resumeAt + 60_000);
  h.monday.expireAccessTokens();
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${first.callId}`).crmStatus, "synced");
  assert.equal(h.store.callRows.get(`ws-a\0${second.callId}`).crmStatus, "synced");
});

test("DLQ: a call that keeps failing is marked failed and dead-lettered after 8 attempts", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.failNext("search", { status: 500, body: {}, times: 100 });
  h.enqueueCall(call);
  await h.drain({ maxRounds: 200 });
  assert.equal(h.queue.dlq.length, 1);
  assert.equal(h.queue.dlq[0].receiveCount, 8);
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "failed");
  assert.equal(row.crmLastErrorCode, "transient");
  assert.equal(h.metrics.sum("DeadLettered"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").lastSyncStatus, "failed");

  // Redrive after the outage: the same message is safe to replay.
  h.monday.clearFailures();
  h.queue.messages.push({ ...h.queue.dlq.pop(), receiveCount: 0, visibleAt: 0 });
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

test("DLQ: malformed messages are dropped, and one bad message does not fail its batch-mates", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.queue.send({ nonsense: true });
  h.enqueueCall(call);
  const event = h.queue.receive();
  const result = await h.worker(event);
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

test("queue failure inside the store is retried like any other transient failure", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.store.failNext("acquireLinkLease", Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" }));
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

// ============================================== CRM-side configuration drift ====

test("drift: a deleted board fails the sync permanently and flags the mapping", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.deleteBoard(h.board.id);
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.queue.dlq.length, 0, "no pointless retries");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmLastErrorCode, "mapping_invalid");
  const view = body(await h.api("GET", "/crm/connection", { sub: "sub-admin-a" }));
  assert.equal(view.mappingStatus, "invalid");
  assert.equal(view.mappingProblems[0].field, "board");
  h.monday.reset();
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" })).status, "skipped");
  assert.equal(h.monday.graphqlCount(), 0);
});

// ======================================================= token lifecycle ====

test("tokens: concurrent refreshes in two containers rotate the refresh token exactly once", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.clock.advance(2 * 60 * 60 * 1000);
  const connection = h.store.connections.get("ws-a\0monday#agent-a");
  const [a, b] = await Promise.all([
    h.runtime.sessions.accessTokenFor(structuredClone(connection)),
    h.runtime.sessions.accessTokenFor(structuredClone(connection)),
  ]);
  assert.equal(a, b);
  assert.equal(h.monday.count("oauth_refresh_token"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "connected");
});

test("tokens: a 401 mid-sync triggers one refresh and the sync completes", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.expireAccessTokens();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.equal(h.monday.count("oauth_refresh_token"), 1);
});

test("tokens: ciphertext is bound to its workspace", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const row = h.store.connections.get("ws-a\0monday#agent-a");
  await assert.rejects(h.tokenCrypto.decrypt({ ciphertext: row.encryptedRefreshToken, workspaceId: "ws-b", provider: "monday", purpose: "refresh" }));
  await assert.rejects(h.tokenCrypto.decrypt({ ciphertext: row.encryptedRefreshToken, workspaceId: "ws-a", provider: "monday", purpose: "access" }));
});

// =============================================================== webhook ====

function lifecycle(h, { type = "uninstall", accountId = "5550001", secret = TEST_APP_SECRET.clientSecret, claims } = {}) {
  const token = signJwt(claims ?? { accountId: Number(accountId), appId: Number(TEST_APP_SECRET.appId), exp: h.clock() / 1000 + 60 }, secret);
  return h.api("POST", "/crm/monday/lifecycle", {
    headers: { Authorization: token },
    body: { type, data: { account_id: Number(accountId), app_id: Number(TEST_APP_SECRET.appId) } },
  });
}

test("webhook: a verified uninstall purges provider data for that Monday account only", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.store.seedConnection({ workspaceId: "ws-b", provider: "monday#agent-b", accountId: "999", connectionState: "connected" });
  const call = h.seedCall({
    crmStatus: "synced",
    crmItemId: "123",
    crmItemUrl: "https://example.monday.com/boards/1/pulses/123",
    crmActivityId: "456",
  });
  await h.store.saveLink("ws-a", linkKeyFor("monday#agent-a", call.callerNumber), {
    provider: "monday",
    state: "linked",
    externalId: "123",
  });
  const response = await lifecycle(h);
  assert.equal(response.statusCode, 200);
  assert.equal(h.store.connections.has("ws-a\0monday#agent-a"), false);
  assert.equal(h.store.links.has(`ws-a\0${linkKeyFor("monday#agent-a", call.callerNumber)}`), false);
  const retainedCall = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(retainedCall.callSummary, call.callSummary, "independent call history is retained");
  assert.equal(retainedCall.crmProvider, undefined);
  assert.equal(retainedCall.crmItemId, undefined);
  assert.equal(retainedCall.crmItemUrl, undefined);
  assert.equal(retainedCall.crmActivityId, undefined);
  assert.equal(retainedCall.crmStatus, undefined);
  assert.equal(h.store.connections.get("ws-b\0monday#agent-b").connectionState, "connected");
  assert.equal((await lifecycle(h)).statusCode, 200, "duplicate delivery is harmless");
});

test("webhook: forged, expired, cross-account and cross-app requests are rejected", async () => {
  const h = createHarness();
  await h.connectAndMap();
  assert.equal((await lifecycle(h, { secret: "wrong" })).statusCode, 401);
  assert.equal((await lifecycle(h, { secret: TEST_APP_SECRET.signingSecret })).statusCode, 401, "lifecycle uses the client secret");
  assert.equal((await lifecycle(h, { claims: { accountId: 5550001, exp: h.clock() / 1000 - 3600 } })).statusCode, 401);
  assert.equal((await lifecycle(h, { claims: { accountId: 42, exp: h.clock() / 1000 + 60 } })).statusCode, 401);
  assert.equal((await lifecycle(h, { claims: { accountId: 5550001, appId: 1, exp: h.clock() / 1000 + 60 } })).statusCode, 401);
  const noHeader = await h.api("POST", "/crm/monday/lifecycle", { body: { type: "uninstall", data: { account_id: 5550001 } } });
  assert.equal(noHeader.statusCode, 401);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "connected");
  assert.equal(h.metrics.sum("Webhook", { Outcome: "rejected" }), 6);
});

test("webhook: other lifecycle events are acknowledged without side effects", async () => {
  const h = createHarness();
  await h.connectAndMap();
  assert.equal((await lifecycle(h, { type: "install" })).statusCode, 200);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "connected");
});

// ====================================================== tenant isolation ====

test("isolation: each workspace sees and configures only its own connection", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const other = await h.api("GET", "/crm/connection", { sub: "sub-admin-b" });
  assert.equal(other.body, "null");
  assert.equal((await h.api("DELETE", "/crm/connection", { sub: "sub-admin-b" })).body, "null");
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "connected");
  assert.equal((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-b" })).statusCode, 409);
  const lookup = await h.runtime.lookup({ workspaceId: "ws-b", agentId: "agent-b", callerNumber: "+12025550198" });
  assert.equal(lookup.status, "skipped");
});

test("isolation: a message naming another workspace's call does nothing to either", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.queue.send({ v: 1, workspaceId: "ws-b", callId: call.callId });
  await h.drain();
  assert.equal(h.monday.graphqlCount(), 0);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "pending");
});

test("unknown routes 404", async () => {
  const h = createHarness();
  assert.equal((await h.api("GET", "/crm/nope", { sub: "sub-admin-a" })).statusCode, 404);
});

// ============================================================ token keeper ====

test("keeper: refreshes tokens nearing expiry so the call-time lookup never has to", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const fresh = await h.runtime.refreshTokens();
  assert.deepEqual(fresh, { connected: 1, refreshed: 0, fresh: 1, failed: 0, deferred: 0, requeued: 0 }, "a new token is left alone");

  h.clock.advance(40 * 60 * 1000);
  const due = await h.runtime.refreshTokens();
  assert.equal(due.refreshed, 1);
  assert.equal(h.monday.count("oauth_refresh_token"), 1);

  h.clock.advance(30 * 60 * 1000);
  h.monday.reset();
  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(lookup.status, "found");
  assert.equal(h.monday.count("oauth_refresh_token"), 0, "no refresh on the live path");
});

test("keeper: a revoked grant is flagged before the next call arrives", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.revokeAll();
  h.clock.advance(40 * 60 * 1000);
  const result = await h.runtime.refreshTokens();
  assert.equal(result.failed, 1);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "reauth_required");
  assert.equal(h.metrics.sum("KeeperFailed"), 1);
});

test("keeper: one tenant's storage error does not stop the others", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.store.seedConnection({
    workspaceId: "ws-b",
    provider: "monday",
    connectionState: "connected",
    accessTokenExpiresAt: h.clock() + 24 * 60 * 60 * 1000,
  });
  h.store.failNext("getConnection", Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
  const result = await h.runtime.refreshTokens();
  assert.equal(result.failed, 1, "the throttled tenant");
  assert.equal(result.fresh, 1, "the other tenant was still checked");
});

test("keeper: skips disconnected workspaces and never touches their tokens", async () => {
  const h = createHarness();
  await h.connectAndMap();
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  h.clock.advance(55 * 60 * 1000);
  assert.deepEqual(await h.runtime.refreshTokens(), { connected: 0, refreshed: 0, fresh: 0, failed: 0, deferred: 0, requeued: 0 });
});

test("an unexpected (non-Monday) failure is recorded on the call while it retries", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.store.failNext("updateCallSync", Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
  await assert.rejects(h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId }));
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "retrying");
  assert.equal(row.crmLastErrorCode, "unexpected");
});

test("the Lambda handler routes the scheduled keeper event", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const handler = createHandler({ getRuntime: async () => h.runtime });
  assert.deepEqual(await handler({ action: "refresh-tokens" }), { connected: 1, refreshed: 0, fresh: 1, failed: 0, deferred: 0, requeued: 0 });
});

test("keeper: refreshes many tenants in parallel and defers what doesn't fit its time budget", async () => {
  const { createTokenKeeper } = await import("./keeper.mjs");
  let clock = 0;
  const rows = Array.from({ length: 12 }, (_, i) => ({ workspaceId: `ws-${i}`, provider: "monday#agent-a" }));
  let inFlight = 0;
  let peak = 0;
  const keeper = createTokenKeeper({
    store: {
      listConnected: async () => rows,
      getConnection: async (workspaceId) => ({ workspaceId, connectionState: "connected", accessTokenExpiresAt: clock + 60_000 }),
    },
    sessions: {
      accessTokenFor: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        clock += 1_000;
        inFlight -= 1;
      },
    },
    now: () => clock,
    log: {},
    concurrency: 5,
    budgetMs: 1_500,
  });
  const result = await keeper();
  assert.equal(peak, 5, "at most 5 refreshes at once");
  assert.ok(result.refreshed >= 5 && result.deferred > 0, JSON.stringify(result));
  assert.equal(result.refreshed + result.deferred, 12);
});

test("keeper: calls that failed through a long Monday outage are replayed automatically once Monday is back", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("search", { status: 500, body: {}, times: 100 });
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a ${call.callId}`).crmStatus, "failed", "retries ran out during the outage");

  const broken = h.seedCall({ callerNumber: "+12025550122" });
  Object.assign(h.store.callRows.get(`ws-a ${broken.callId}`), { crmStatus: "failed", crmLastErrorCode: "mapping_invalid" });

  h.monday.recover();
  const first = await h.runtime.refreshTokens();
  assert.equal(first.requeued, 1, "only the outage failure is replayed, not the mapping problem");
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a ${call.callId}`).crmStatus, "synced");
  assert.equal(h.store.callRows.get(`ws-a ${broken.callId}`).crmStatus, "failed");

  const again = await h.runtime.refreshTokens();
  assert.equal(again.requeued, 0, "throttled to once per 30 minutes");
});

test("boards: private, subitem and document boards are left out of the picker, but an already-mapped board keeps validating", async () => {
  const h = createHarness();
  const secret = h.monday.addBoard({ name: "Board Of Directors", kind: "private" });
  h.monday.addBoard({ name: "Subitems of Leads", type: "sub_items_board" });
  h.monday.addBoard({ name: "Meeting notes", type: "document" });
  h.monday.addBoard({ name: "Shared With Client", kind: "share" });
  await h.connect();
  const listed = JSON.parse((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-a" })).body).boards.map((b) => b.name);
  assert.deepEqual(listed.sort(), ["Leads", "Shared With Client"]);

  await h.connectAndMap();
  secret.kind = "private";
  h.board.kind = "private";
  const reconnect = await h.connect();
  assert.equal(reconnect.callback.statusCode, 302);
  const connection = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(connection.mappingStatus, "valid", "making the mapped board private later doesn't break syncing");
});

// ============================================================ per agent ====

test("per agent: each agent has its own Monday connection; another agent's calls never use it", async () => {
  const h = createHarness();
  h.store.seedAgent("ws-a", "agent-a2", { name: "Spanish Line" });
  await h.connectAndMap();
  const connection = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(connection.agentId, "agent-a");
  assert.equal(connection.provider, "monday");
  assert.equal(JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a", agent: "agent-a2" })).body), null, "the second agent is not connected");

  const other = h.seedCall({ agentId: "agent-a2", crmProvider: undefined });
  h.enqueueCall(h.store.callRows.get(`ws-a\0${other.callId}`));
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${other.callId}`);
  assert.equal(row.crmStatus, "skipped");
  assert.equal(h.monday.count("create_item"), 0, "nothing written to agent-a's board");

  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a2", callerNumber: "+12025550198" });
  assert.equal(lookup.reason, "not_connected");
});

test("per agent: settings routes refuse a missing, unknown, deleted or other-workspace agent", async () => {
  const h = createHarness();
  h.store.seedAgent("ws-a", "agent-gone", { status: "deleted" });
  const status = async (agent) => (await h.api("GET", "/crm/connection", { sub: "sub-admin-a", agent })).statusCode;
  assert.equal(await status(null), 400);
  assert.equal(await status("agent-nope"), 404);
  assert.equal(await status("agent-gone"), 404);
  assert.equal(await status("agent-b"), 404, "ws-b's agent is invisible to ws-a");
  assert.equal(await status("agent-a"), 200);
});

test("per agent: a call queued under the old workspace-level key still syncs through its agent", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall({ crmProvider: "monday" });
  h.enqueueCall(call);
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.equal(row.crmProvider, "monday#agent-a");
});

// ========================================================== calls board ====

function callsBoardOf(h) {
  const connection = h.store.connections.get("ws-a\0monday#agent-a");
  return { connection, board: h.monday.boardsById.get(String(connection.callsBoard?.id)) };
}

test("calls board: connecting creates 'Symantic AI Calls - <agent>' with the fixed columns; reconnecting reuses it", async () => {
  const h = createHarness();
  await h.connect();
  const { connection, board } = callsBoardOf(h);
  assert.equal(connection.callsBoard.status, "active");
  assert.equal(board.name, "Symantic AI Calls - Front Desk");
  assert.deepEqual(board.columns.slice(1).map((c) => c.title), [
    "Phone", "Company Name", "Date & Time", "Duration (Min)", "Direction", "Outcome", "Reason for Call",
    "Summary", "Appointment Set", "Sentiment", "Follow-Up", "Email", "Recording", "Transcript", "Call ID",
  ]);
  assert.deepEqual(board.columns.find((c) => c.title === "Direction").labels, ["Inbound", "Outbound"]);
  assert.equal(connection.boardSyncEnabled, false, "your own board is opt-in");
  await h.connect();
  assert.equal(h.monday.createdBoards.length, 1, "no second board on reconnect");
  const listed = JSON.parse((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-a" })).body).boards;
  assert.ok(!listed.some((b) => b.id === board.id), "the calls board is never offered for mapping");
  const pub = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(pub.callsBoard.status, "active");
  assert.match(pub.callsBoard.url, new RegExp(`/boards/${board.id}$`));
});

test("calls board: with no board of your own mapped, every call still gets exactly one row", async () => {
  const h = createHarness();
  await h.connect();
  const call = h.seedCall({
    direction: "inbound",
    userSentiment: "Positive",
    followUp: { status: "not_started", comment: "Call back" },
    toolLog: toolLogFor([{ name: "calendar_create_booking", args: {}, output: { ok: true, startTimeUtc: "2026-10-01T14:00:00.000Z" } }]),
  });
  h.enqueueCall(call);
  await h.drain();
  h.enqueueCall(call);
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  const { board } = callsBoardOf(h);
  const rows = [...h.monday.items.values()].filter((item) => item.boardId === board.id);
  assert.equal(rows.length, 1, "retries never add a second row");
  const byTitle = Object.fromEntries(board.columns.map((c) => [c.title, rows[0].values[c.id]?.text]));
  assert.equal(rows[0].name, "Jane Doe");
  assert.equal(byTitle.Phone, "+12025550198");
  assert.equal(byTitle.Direction, "Inbound");
  assert.equal(byTitle["Appointment Set"], "Yes");
  assert.equal(byTitle.Sentiment, "Positive");
  assert.equal(byTitle["Duration (Min)"], "2");
  assert.equal(byTitle.Summary, "Caller asked about whitening prices and hours.");
  assert.equal(byTitle["Follow-Up"], "Not started - Call back");
  assert.equal(h.monday.count("create_item"), 0, "no lead is created without your own board");
});

test("calls board: Monday refusing to create it never fails the connection, and the reason is shown", async () => {
  const h = createHarness();
  h.monday.boardCreation.refuse = "UserUnauthorizedException";
  const { callback } = await h.connect();
  assert.equal(callback.statusCode, 302);
  assert.match(callback.headers.location, /crm=connected/);
  const pub = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(pub.callsBoard.status, "failed");
  assert.match(pub.callsBoard.message, /administrator/);

  // Mapping your own board still works, and calls still sync there.
  h.monday.boardCreation.refuse = null;
  await h.configureMapping();
  h.monday.boardCreation.refuse = "UserUnauthorizedException";
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.equal(h.monday.count("create_item"), 1, "the lead was created on your board");
});

test("calls board deleted in Monday: never recreated on its own; the call is held and still synced to your own board", async () => {
  const h = createHarness();
  await h.connect();
  const first = callsBoardOf(h).board;
  first.deleted = true;
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const { connection } = callsBoardOf(h);
  assert.equal(connection.callsBoard.status, "deleted");
  assert.equal(connection.callsBoard.id, first.id, "the old id is kept so a restore is recognised");
  assert.equal(h.monday.createdBoards.length, 1, "no replacement board without an admin");
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.equal(row.crmCallsItemId, undefined, "held: no row yet");
  const pub = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(pub.callsBoard.status, "deleted");
  assert.match(pub.callsBoard.message, /was deleted in Monday/);
});

test("board sync toggle: off skips your board but keeps the mapping; on resumes it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const off = await h.api("PUT", "/crm/board-sync", { sub: "sub-admin-a", body: { enabled: false } });
  assert.equal(JSON.parse(off.body).boardSyncEnabled, false);
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.monday.count("create_item"), 0);
  assert.equal(h.monday.count("create_calls_row"), 1);
  assert.ok(h.store.connections.get("ws-a\0monday#agent-a").mapping, "mapping kept");
  assert.equal((await h.api("PUT", "/crm/board-sync", { sub: "sub-member-a", groups: ["quotation-builder"], body: { enabled: true } })).statusCode, 403);
  const on = await h.api("PUT", "/crm/board-sync", { sub: "sub-admin-a", body: { enabled: true } });
  assert.equal(JSON.parse(on.body).boardSyncEnabled, true);
});

// ============================================================== renewal ====

test("renewal: renewing keeps the mapping and the calls board, and replays missed calls", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const before = h.store.connections.get("ws-a\0monday#agent-a");
  const boardId = before.callsBoard.id;
  const mapping = structuredClone(before.mapping);
  await h.connect();
  const after = h.store.connections.get("ws-a\0monday#agent-a");
  assert.deepEqual(after.mapping, mapping);
  assert.equal(after.callsBoard.id, boardId);
  assert.equal(after.mappingStatus, "valid");
  assert.equal(h.monday.createdBoards.length, 1);
});

test("renewal: a failure mid-renewal leaves the working connection exactly as it was", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const before = structuredClone(h.store.connections.get("ws-a\0monday#agent-a"));
  h.monday.failNext("me", { status: 500, body: {} });
  const { callback } = await h.connect();
  assert.match(callback.headers.location, /crm=error&reason=connection_failed/);
  const after = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(after.encryptedRefreshToken, before.encryptedRefreshToken);
  assert.equal(after.tokenVersion, before.tokenVersion);
  assert.deepEqual(after.mapping, before.mapping);
});

test("renewal: approving with a different Monday account keeps but flags the mapping and logs to a new board there", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const firstBoard = h.store.connections.get("ws-a\0monday#agent-a").callsBoard.id;
  // Real Monday accounts can't see each other's boards; the fake shares one
  // list, so hide the first account's board from the new account's search.
  h.monday.boardsById.get(String(firstBoard)).name = "Other account's board";
  h.monday.switchAccount("7770002", "Other Co");
  await h.connect();
  const after = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(after.mappingStatus, "invalid");
  assert.equal(after.mappingProblems[0].code, "account_changed");
  assert.match(after.mappingProblems[0].message, /different Monday account \(Other Co\)/);
  assert.ok(after.mapping, "mapping kept so switching back fixes it");
  assert.notEqual(after.callsBoard.id, firstBoard);
});

test("inactive Monday account: syncing pauses for a day (no retry storm), calls still answered, Check Again resumes and replays", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("create_calls_row", { status: 200, body: h.monday.errorBody("AccountDeactivated", "This account has been deactivated") });
  const call = h.seedCall();
  h.enqueueCall(call);
  const event = h.queue.receive();
  h.queue.settle(event, await h.worker(event));
  const connection = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(connection.pauseReason, "account_inactive");
  assert.equal(connection.connectionState, "connected", "not a reconnect");
  assert.ok(h.queue.messages[0].visibleAt - h.clock() >= 11 * 3_600_000, "retried hours later (SQS caps a delay at 12h), not in seconds");

  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(lookup.reason, "paused", "the live call skips Monday instead of waiting on it");

  const pub = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.equal(pub.pauseReason, "account_inactive");

  const check = await h.api("POST", "/crm/check-account", { sub: "sub-admin-a", body: {} });
  assert.equal(check.statusCode, 200);
  assert.equal(JSON.parse(check.body).pausedUntil, null);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").pauseReason, undefined);
});

test("inactive Monday account: Check Again while still inactive explains what to do", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("me", { status: 200, body: h.monday.errorBody("AccountSuspended", "Account is suspended") });
  const check = await h.api("POST", "/crm/check-account", { sub: "sub-admin-a", body: {} });
  assert.equal(check.statusCode, 409);
  assert.equal(JSON.parse(check.body).error, "account_inactive");
  assert.match(JSON.parse(check.body).message, /Reactivate it in Monday/);
});

test("agent deletion: disconnect-agent revokes and clears this agent's Monday only, and is 'none' when there's nothing", async () => {
  const h = createHarness();
  h.store.seedAgent("ws-a", "agent-a2", { name: "Spanish Line" });
  await h.connectAndMap();
  const result = await h.runtime.disconnectAgent({ workspaceId: "ws-a", agentId: "agent-a" });
  assert.equal(result.status, "done");
  assert.equal(result.accountName, "Acme Dental");
  const row = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(row.connectionState, "disconnected");
  assert.equal(row.encryptedRefreshToken, undefined);
  assert.equal(h.monday.revoked.length, 1);
  assert.deepEqual(await h.runtime.disconnectAgent({ workspaceId: "ws-a", agentId: "agent-a2" }), { status: "none" });
  assert.deepEqual(await h.runtime.disconnectAgent({ workspaceId: "ws-a", agentId: "agent-a" }), { status: "none" }, "safe to run twice");
});

test("connect: the OAuth callback only queues the calls board, so it returns fast; the worker builds it", async () => {
  const h = createHarness();
  const start = await h.api("POST", "/crm/monday/start", { sub: "sub-admin-a", body: { returnTo: "/integrations" } });
  const url = new URL(JSON.parse(start.body).authorizeUrl);
  const code = h.monday.issueCode({ redirectUri: url.searchParams.get("redirect_uri"), challenge: url.searchParams.get("code_challenge") });
  const callback = await h.api("GET", "/crm/oauth/monday/callback", { query: { code, state: url.searchParams.get("state") } });
  assert.match(callback.headers.location, /crm=connected/);
  assert.equal(h.monday.count("create_board"), 0, "no board work inside the callback");
  assert.equal(h.queue.messages.length, 1);
  await h.drain();
  assert.equal(h.monday.count("create_board"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").callsBoard.status, "active");
});

test("calls board dedupe: two workers at once create one board; a lost record reuses the board by name", async () => {
  const h = createHarness();
  await h.connect();
  const connection = h.store.connections.get("ws-a monday#agent-a");
  const first = connection.callsBoard.id;
  // The record is lost (e.g. a timed-out save): the next sync finds the
  // agent's existing board by name instead of creating another.
  delete connection.callsBoard;
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.connections.get("ws-a monday#agent-a").callsBoard.id, first);
  assert.equal(h.monday.createdBoards.length, 1, "no second board");

  // Two calls race with no board on record: the claim lets only one build it.
  delete h.store.connections.get("ws-a monday#agent-a").callsBoard;
  h.monday.boardsById.get(String(first)).name = "renamed by the customer";
  const a = h.seedCall({ callerNumber: "+12025550111" });
  const b = h.seedCall({ callerNumber: "+12025550122" });
  await Promise.allSettled([
    h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: a.callId }),
    h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: b.callId }),
  ]);
  assert.equal(h.monday.createdBoards.length, 2, "exactly one new board despite two concurrent syncs");
});

test("calls board dedupe is per agent: each agent still gets its own board", async () => {
  const h = createHarness();
  await h.connect();
  await h.connect({ sub: "sub-admin-b" });
  assert.equal(h.monday.createdBoards.length, 2);
  const names = h.monday.createdBoards.map((id) => h.monday.boardsById.get(id).name).sort();
  assert.deepEqual(names, ["Symantic AI Calls - Front Desk", "Symantic AI Calls - Reception"]);
});

// ============================================================ Part H ====

function rowsOn(h, boardId) {
  return [...h.monday.items.values()].filter((item) => item.boardId === String(boardId) && item.state === "active");
}

test("Recreate Board builds a new board and puts the agent's full history on it, once", async () => {
  const h = createHarness();
  await h.connect();
  const calls = [h.seedCall(), h.seedCall({ callerNumber: "+12025550111" }), h.seedCall({ callerNumber: "+12025550122", demoSeed: true })];
  for (const call of calls) h.enqueueCall(call);
  await h.drain();
  const old = callsBoardOf(h).board;
  assert.equal(rowsOn(h, old.id).length, 2, "sample calls never go to Monday");
  old.deleted = true;
  const held = h.seedCall({ callerNumber: "+12025550133" });
  h.enqueueCall(held);
  await h.drain();

  const response = await h.api("POST", "/crm/calls-board", { sub: "sub-admin-a", body: { action: "recreate" } });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).callsBoardQueued, true);
  await h.drain();
  const { connection, board } = callsBoardOf(h);
  assert.notEqual(board.id, old.id);
  assert.equal(connection.callsBoard.status, "active");
  assert.equal(rowsOn(h, board.id).length, 3, "full history plus the held call");

  // Running the rebuild again adds nothing.
  await h.api("POST", "/crm/calls-board", { sub: "sub-admin-a", body: { action: "start" } });
  await h.drain();
  assert.equal(rowsOn(h, board.id).length, 3);
});

test("the 10-minute check spots a deleted board, emails once, reminds after 3 days, and resumes when it's restored", async () => {
  const h = createHarness();
  await h.connect();
  const board = callsBoardOf(h).board;
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  board.deleted = true;
  await h.runtime.refreshTokens();
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").callsBoard.status, "deleted");

  // Restored from Monday's trash: same board, active again, nothing re-added.
  board.deleted = false;
  const missed = h.seedCall({ callerNumber: "+12025550111" });
  await h.runtime.refreshTokens();
  await h.drain();
  const connection = h.store.connections.get("ws-a\0monday#agent-a");
  assert.equal(connection.callsBoard.status, "active");
  assert.equal(connection.callsBoard.id, board.id);
  assert.equal(rowsOn(h, board.id).length, 2, "the restored board gets only the call it missed");
  void missed;
});

test("board-deleted emails: once right away and one reminder after 3 days", async () => {
  const { createReauthReminders } = await import("./reminders.mjs");
  const { createMemoryCrmStore } = await import("./test-support/fakes.mjs");
  let now = Date.parse("2026-09-01T00:00:00Z");
  const store = createMemoryCrmStore({
    now: () => now,
    memberships: { "user-dana": { workspaceId: "ws", status: "active", role: "company-admin", email: "dana@example.com" } },
    agents: { "ws\0agent-1": { name: "Front Desk", status: "active" } },
  });
  store.seedConnection({ workspaceId: "ws", provider: "monday#agent-1", agentId: "agent-1", connectionState: "connected", authorizedBy: "user-dana",
    refreshTokenExpiresAt: now + 90 * 86_400_000, callsBoard: { id: "1", status: "deleted" } });
  const sent = [];
  const remind = createReauthReminders({ store, sendEmail: async (m) => { sent.push(m); }, appUrl: "https://app.test", now: () => now });
  const conn = () => store.getConnection("ws", "monday#agent-1");
  assert.equal(await remind(await conn()), true);
  assert.equal(await remind(await conn()), false);
  now += 3 * 86_400_000;
  assert.equal(await remind(await conn()), true);
  assert.equal(await remind(await conn()), false);
  assert.deepEqual(sent.map((m) => m.subject), ["Your Monday calls board was deleted", "Reminder: your Monday calls board is still missing"]);
  assert.match(sent[0].html, /agentId=agent-1&amp;crm=board/);
  assert.match(sent[0].text, /"Front Desk" agent/);
});

test("Stop Logging writes nothing to a calls board; turning it back on adds what's missing", async () => {
  const h = createHarness();
  await h.connect();
  const board = callsBoardOf(h).board;
  const stop = await h.api("POST", "/crm/calls-board", { sub: "sub-admin-a", body: { action: "stop" } });
  assert.equal(JSON.parse(stop.body).callsBoardEnabled, false);
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(rowsOn(h, board.id).length, 0);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  await h.api("POST", "/crm/calls-board", { sub: "sub-admin-a", body: { action: "start" } });
  await h.drain();
  assert.equal(rowsOn(h, board.id).length, 1);
  assert.equal((await h.api("POST", "/crm/calls-board", { sub: "sub-admin-a", body: { action: "nope" } })).statusCode, 400);
});

test("reconnect with the board still there: only calls taken while disconnected are added, never duplicates", async () => {
  const h = createHarness();
  await h.connect();
  const before = h.seedCall();
  h.enqueueCall(before);
  await h.drain();
  const board = callsBoardOf(h).board;
  assert.equal(rowsOn(h, board.id).length, 1);

  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  h.clock.advance(60_000);
  // Taken while disconnected: never queued, so it has no sync status.
  const during = h.seedCall({ callerNumber: "+12025550111", analyzedAt: new Date(h.clock()).toISOString(), crmStatus: undefined });
  void during;
  await h.connect();
  await h.drain();
  assert.equal(callsBoardOf(h).board.id, board.id, "same board reused");
  assert.equal(rowsOn(h, board.id).length, 2, "only the missed call was added");

  await h.connect();
  await h.drain();
  assert.equal(rowsOn(h, board.id).length, 2, "reconnecting again adds nothing");
});

test("a call whose record was lost but whose row exists is linked by Call ID, not written twice", async () => {
  const h = createHarness();
  await h.connect();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const board = callsBoardOf(h).board;
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  const itemId = row.crmCallsItemId;
  delete row.crmCallsItemId;
  delete row.crmCallsBoardId;
  await h.runtime.sync.syncCallsBoardRow({ workspaceId: "ws-a", callId: call.callId, provider: "monday#agent-a" });
  assert.equal(rowsOn(h, board.id).length, 1);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId, itemId);
});

test("Listen links go to Call History's pop-up for that call, and old links can be rewritten in place", async () => {
  const h = createHarness();
  await h.connect();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const board = callsBoardOf(h).board;
  const recordingColumn = board.columns.find((c) => c.title === "Recording").id;
  const item = rowsOn(h, board.id)[0];
  assert.match(item.values[recordingColumn].value, new RegExp(`/call-history\\?call=${call.callId}`));
  item.values[recordingColumn] = { text: "Listen", value: JSON.stringify({ url: "https://old/calls/x" }) };
  const result = await h.runtime.sync.rewriteCallLinks({ workspaceId: "ws-a", callId: call.callId, provider: "monday#agent-a" });
  assert.equal(result.updated, 1);
  assert.equal(rowsOn(h, board.id).length, 1, "updated in place");
});

// =============================================== calls-board guards ====

const HOUR = 60 * 60 * 1000;
const conn = (h) => h.store.connections.get("ws-a\0monday#agent-a");

test("no Symantic AI Calls board is ever offered for mapping: any agent's, renamed, or found by name", async () => {
  const h = createHarness();
  await h.connect();
  const own = callsBoardOf(h).board;
  own.name = "Our call log (renamed)";
  const other = h.monday.addBoard({ name: "Board of another agent" });
  h.store.seedConnection({ workspaceId: "ws-a", provider: "monday#agent-x", agentId: "agent-x", connectionState: "connected",
    callsBoard: { id: other.id, status: "active", columns: {} } });
  const leftover = h.monday.addBoard({ name: "Symantic AI Calls - Old Agent" });
  const plain = h.monday.addBoard({ name: "Symantic AI Calls" });
  const listed = JSON.parse((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-a" })).body).boards.map((b) => b.id);
  for (const hidden of [own, other, leftover, plain]) assert.ok(!listed.includes(hidden.id), `${hidden.name} is hidden`);
  assert.ok(listed.includes(h.board.id), "the customer's own boards are still listed");
});

test("saving a mapping to a calls board is refused, even when the request names it directly", async () => {
  const h = createHarness();
  await h.connect();
  const own = callsBoardOf(h).board;
  const refused = await h.api("PUT", "/crm/mapping", { sub: "sub-admin-a", body: { mapping: {
    boardId: own.id, columns: { phone: { id: own.columns.find((c) => c.type === "phone").id } },
    labels: { newLead: null, followUp: null }, defaultOwnerId: null } } });
  assert.equal(refused.statusCode, 422);
  assert.equal(JSON.parse(refused.body).problems[0].code, "calls_board");
  const byName = h.monday.addBoard({ name: "Symantic AI Calls - Someone" });
  const refusedByName = await h.api("PUT", "/crm/mapping", { sub: "sub-admin-a", body: { mapping: {
    boardId: byName.id, columns: { phone: { id: byName.columns.find((c) => c.type === "phone").id } },
    labels: { newLead: null, followUp: null }, defaultOwnerId: null } } });
  assert.equal(refusedByName.statusCode, 422);
});

test("an existing mapping that points at a calls board is flagged by the hourly check and never synced to", async () => {
  const h = createHarness();
  await h.connectAndMap();
  // Someone else's calls board ends up being the mapped board (e.g. it was
  // mapped before these guards, or its record appeared later).
  h.store.seedConnection({ workspaceId: "ws-a", provider: "monday#agent-x", agentId: "agent-x", connectionState: "connected",
    callsBoard: { id: h.board.id, status: "active", columns: {} } });
  h.clock.advance(HOUR + 1000);
  await h.runtime.refreshTokens();
  assert.equal(conn(h).mappingStatus, "invalid");
  assert.ok(conn(h).mappingProblems.some((problem) => problem.code === "calls_board"));
});

test("calls board: a renamed column is kept (no duplicate) when another column is repaired", async () => {
  const h = createHarness();
  await h.connect();
  const { board, connection } = callsBoardOf(h);
  const company = board.columns.find((c) => c.id === connection.callsBoard.columns.companyName);
  company.title = "Company";
  h.monday.removeColumn(board.id, connection.callsBoard.columns.callId);
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const after = callsBoardOf(h);
  assert.ok(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId, "the row was written");
  assert.equal(after.connection.callsBoard.columns.companyName, company.id, "renamed column kept");
  assert.equal(after.board.columns.filter((c) => c.title === "Company Name").length, 0, "no duplicate Company Name column");
  assert.equal(after.board.columns.filter((c) => c.title === "Call ID").length, 1, "the deleted column is back once");
});

test("calls board: a column changed to another type in Monday is replaced and the call still logs", async () => {
  const h = createHarness();
  await h.connect();
  const { board, connection } = callsBoardOf(h);
  const outcome = board.columns.find((c) => c.id === connection.callsBoard.columns.outcome);
  outcome.type = "status";
  outcome.labels = [];
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const after = callsBoardOf(h);
  assert.ok(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId, "the row was written");
  assert.notEqual(after.connection.callsBoard.columns.outcome, outcome.id, "a new text Outcome column is used");
  assert.equal(after.board.columns.find((c) => c.id === after.connection.callsBoard.columns.outcome).type, "text");
});

test("board-sync-needs-attention email: once per breakage, re-armed when the mapping is valid again", async () => {
  const { createReauthReminders, renderMappingInvalidEmail } = await import("./reminders.mjs");
  const { createMemoryCrmStore } = await import("./test-support/fakes.mjs");
  const now = Date.parse("2026-09-01T00:00:00Z");
  const store = createMemoryCrmStore({
    now: () => now,
    memberships: { "user-dana": { workspaceId: "ws", status: "active", role: "company-admin", email: "dana@example.com" } },
    agents: { "ws\0agent-1": { name: "Front Desk", status: "active" } },
  });
  const mapping = { boardId: "5", boardName: "Leads", columns: {}, labels: {} };
  store.seedConnection({ workspaceId: "ws", provider: "monday#agent-1", agentId: "agent-1", connectionState: "connected", authorizedBy: "user-dana",
    refreshTokenExpiresAt: now + 90 * 86_400_000, mapping, mappingStatus: "invalid",
    mappingProblems: [{ field: "outcome", code: "column_missing", message: "The Outcome column was deleted." }] });
  const sent = [];
  const remind = createReauthReminders({ store, sendEmail: async (m) => { sent.push(m); }, appUrl: "https://app.test", now: () => now });
  const current = () => store.getConnection("ws", "monday#agent-1");
  assert.equal(await remind(await current()), true);
  assert.equal(await remind(await current()), false, "not twice");
  assert.equal(sent[0].subject, "Monday board sync needs attention");
  assert.match(sent[0].text, /The Outcome column was deleted\./);
  assert.match(sent[0].html, /agentId=agent-1&amp;crm=mapping/);
  await store.saveMapping("ws", "monday#agent-1", mapping, { status: "valid", problems: [] });
  await store.markMappingInvalid("ws", "monday#agent-1", [{ field: "board", code: "board_missing", message: "The board was deleted." }]);
  assert.equal(await remind(await current()), true, "a new breakage emails again");
  assert.equal(renderMappingInvalidEmail({ connection: { mapping }, appUrl: "https://x" }).subject, "Monday board sync needs attention");
});

// ============================================ Part K: shared Monday account ====

// An English agent (agent-a) and a Spanish agent (agent-es) in one workspace,
// both connected to the same Monday account and mapped to the same board.
async function twoAgentsOneBoard() {
  const h = createHarness();
  h.store.seedAgent("ws-a", "agent-es", { name: "Spanish Line" });
  await h.connectAndMap();
  await h.connect({ agent: "agent-es" });
  const mapped = await h.configureMapping({ agent: "agent-es" });
  assert.equal(mapped.statusCode, 200, "the same board can be mapped by a second agent");
  return h;
}
const rowsWithPhone = (h, phone) => [...h.monday.items.values()]
  .filter((item) => item.boardId === String(h.board.id) && item.state === "active" &&
    Object.values(item.values ?? {}).some((value) => String(value?.text ?? "").replace(/\D/g, "").endsWith(phone.replace(/\D/g, "").slice(-10))));

test("two agents, one board: different callers at the same moment each get their own row", async () => {
  const h = await twoAgentsOneBoard();
  const english = h.seedCall({ callerNumber: "+12025550301", callerName: "Ann English" });
  const spanish = h.seedCall({ agentId: "agent-es", callerNumber: "+12025550302", callerName: "Beto Spanish" });
  h.enqueueCall(english);
  h.enqueueCall(spanish);
  await h.drain();
  const a = h.store.callRows.get(`ws-a\0${english.callId}`);
  const b = h.store.callRows.get(`ws-a\0${spanish.callId}`);
  assert.equal(a.crmStatus, "synced");
  assert.equal(b.crmStatus, "synced");
  assert.ok(a.crmItemId && b.crmItemId && a.crmItemId !== b.crmItemId, "two separate rows");
  assert.equal(rowsWithPhone(h, "+12025550301").length, 1);
  assert.equal(rowsWithPhone(h, "+12025550302").length, 1);
  const boardA = h.store.connections.get("ws-a\0monday#agent-a").callsBoard.id;
  const boardB = h.store.connections.get("ws-a\0monday#agent-es").callsBoard.id;
  assert.notEqual(boardA, boardB, "each agent keeps its own calls board");
});

test("two agents, one board: the same new caller reaching both at once gets exactly one row", async () => {
  const h = await twoAgentsOneBoard();
  const english = h.seedCall({ callerNumber: "+12025550303" });
  const spanish = h.seedCall({ agentId: "agent-es", callerNumber: "+12025550303" });
  h.enqueueCall(english);
  h.enqueueCall(spanish);
  await h.drain();
  assert.equal(rowsWithPhone(h, "+12025550303").length, 1, "no duplicate row");
  assert.equal(h.store.callRows.get(`ws-a\0${english.callId}`).crmItemId, h.store.callRows.get(`ws-a\0${spanish.callId}`).crmItemId);
});

test("a caller link saved per agent (before board-shared links) is still used", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.store.saveLink("ws-a", linkKeyFor("monday#agent-a", "+12025550198"), {
    provider: "monday", phoneE164: "+12025550198", state: "linked", externalId: jane.id, boardId: h.board.id,
  });
  h.monday.reset();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmItemId, jane.id);
  assert.equal(h.monday.count("find_by_phone"), 0, "no search needed");
});

test("disconnecting one agent leaves the other agent on the same Monday account working", async () => {
  const h = await twoAgentsOneBoard();
  const off = await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(off.statusCode, 200);
  assert.equal(h.store.connections.get("ws-a\0monday#agent-a").connectionState, "disconnected");
  assert.equal(h.store.connections.get("ws-a\0monday#agent-es").connectionState, "connected");
  assert.equal(h.monday.revoked.length, 0, "shared grant: not revoked at Monday");
  const call = h.seedCall({ agentId: "agent-es", callerNumber: "+12025550304" });
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced", "the Spanish agent still syncs");
});

test("any disconnect emails the admins once: in-app (by whom), agent deleted, reconnect re-arms", async () => {
  const h = createHarness();
  await h.connect();
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(h.monday.revoked.length, 1, "not shared: revoked at Monday");
  const first = h.emails.filter((m) => /was disconnected/.test(m.subject));
  assert.equal(first.length, 1);
  assert.match(first[0].text, /by User sub-admin-a in Symantic AI/);
  assert.match(first[0].text, /sent to Monday after you reconnect/);
  assert.match(first[0].html, /Reconnect Monday/);
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(h.emails.filter((m) => /was disconnected/.test(m.subject)).length, 1, "not twice for one disconnect");

  await h.connect();
  const deleted = await h.runtime.disconnectAgent({ workspaceId: "ws-a", agentId: "agent-a" });
  assert.equal(deleted.status, "done");
  const second = h.emails.filter((m) => /was disconnected/.test(m.subject));
  assert.equal(second.length, 2, "a reconnect re-arms the notice");
  assert.match(second[1].text, /because the agent was deleted/);
  assert.doesNotMatch(second[1].html, /Reconnect Monday/);
});

test("uninstalling the Monday app emails once per connected agent before the data is purged", async () => {
  const h = await twoAgentsOneBoard();
  const response = await lifecycle(h);
  assert.equal(response.statusCode, 200);
  const notices = h.emails.filter((m) => /was disconnected/.test(m.subject));
  assert.equal(notices.length, 2);
  assert.ok(notices.every((m) => /Symantic AI app was removed/.test(m.text)));
  assert.equal([...h.store.links.keys()].filter((k) => k.includes("#board#")).length, 0, "shared board links purged too");
});

test("a failing email never blocks the disconnect", async () => {
  const { createDisconnectNotifier } = await import("./reminders.mjs");
  const { createMemoryCrmStore } = await import("./test-support/fakes.mjs");
  const store = createMemoryCrmStore({
    memberships: { "user-dana": { workspaceId: "ws", status: "active", role: "company-admin", email: "dana@example.com" } },
  });
  store.seedConnection({ workspaceId: "ws", provider: "monday#agent-1", agentId: "agent-1", connectionState: "disconnected", authorizedBy: "user-dana" });
  const notify = createDisconnectNotifier({ store, sendEmail: async () => { throw new Error("SES down"); }, appUrl: "https://x", log: { warn() {} } });
  const connection = await store.getConnection("ws", "monday#agent-1");
  assert.equal(await notify(connection, { reason: "user_disconnected" }), true);
});

test("the card and board picker say which other agents share the Monday account and board", async () => {
  const h = await twoAgentsOneBoard();
  const view = JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body);
  assert.deepEqual(view.sharedWith, [{ agentId: "agent-es", agentName: "Spanish Line" }]);
  const boards = JSON.parse((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-a" })).body).boards;
  assert.deepEqual(boards.find((b) => b.id === h.board.id).syncedBy, ["Spanish Line"]);
  const solo = createHarness();
  await solo.connect();
  assert.deepEqual(JSON.parse((await solo.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body).sharedWith, []);
});

test("rewriting a Listen link on a row deleted in Monday is skipped, not retried forever", async () => {
  const h = createHarness();
  await h.connect();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  h.monday.deleteItem(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId);
  const result = await h.runtime.sync.rewriteCallLinks({ workspaceId: "ws-a", callId: call.callId, provider: "monday#agent-a" });
  assert.deepEqual({ status: result.status, updated: result.updated, gone: result.gone }, { status: "done", updated: 0, gone: 1 });
});

// ================================================ Part J: two-way name sync ====

const HOUR_MS = 60 * 60 * 1000;
const webhooksOn = (h, boardId) => [...h.monday.webhooks.values()].filter((w) => w.boardId === String(boardId));
function webhookQuery(h, boardId) {
  const url = new URL(webhooksOn(h, boardId)[0].url);
  return Object.fromEntries(url.searchParams);
}
async function syncedJane(h) {
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const item = h.monday.items.get(String(h.store.callRows.get(`ws-a\0${call.callId}`).crmItemId));
  return { call, item };
}
function renameEvent(h, item, name, at = new Date(h.clock()).toISOString()) {
  return h.api("POST", "/crm/monday/webhook", {
    query: webhookQuery(h, h.board.id),
    body: { event: { type: "update_name", boardId: Number(h.board.id), pulseId: Number(item.id), value: { name }, previousValue: { name: item.name }, triggerTime: at } },
  });
}

test("saving a mapping watches that board for renames; turning board sync off or disconnecting stops it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const hooks = webhooksOn(h, h.board.id);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].event, "change_name");
  assert.match(hooks[0].url, /\/crm\/monday\/webhook\?w=ws-a&a=agent-a&s=/);
  const callsBoardId = conn(h).callsBoard.id;
  assert.equal(webhooksOn(h, callsBoardId).length, 0, "never the Symantic AI Calls board");
  assert.equal(JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body).nameSync, "instant");

  await h.api("PUT", "/crm/board-sync", { sub: "sub-admin-a", body: { enabled: false } });
  await h.drain();
  assert.equal(h.monday.webhooks.size, 0);
  assert.equal(JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body).nameSync, "off");

  await h.api("PUT", "/crm/board-sync", { sub: "sub-admin-a", body: { enabled: true } });
  await h.drain();
  assert.equal(h.monday.webhooks.size, 1);
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(h.monday.webhooks.size, 0, "removed before the tokens were deleted");
});

test("the webhook route: wrong signature is refused, Monday's challenge is echoed", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const good = webhookQuery(h, h.board.id);
  const bad = await h.api("POST", "/crm/monday/webhook", { query: { ...good, s: "x".repeat(32) }, body: { challenge: "abc" } });
  assert.equal(bad.statusCode, 401);
  const forged = await h.api("POST", "/crm/monday/webhook", { query: { ...good, w: "ws-b" }, body: { challenge: "abc" } });
  assert.equal(forged.statusCode, 401, "a signature is bound to its workspace");
  const challenge = await h.api("POST", "/crm/monday/webhook", { query: good, body: { challenge: "abc" } });
  assert.deepEqual(JSON.parse(challenge.body), { challenge: "abc" });
});

test("renamed in Monday: the contact and every call from that number take the new name", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { call, item } = await syncedJane(h);
  const older = h.seedCall({ crmStatus: "synced" });
  h.clock.advance(60_000);
  const response = await renameEvent(h, item, "Jane Smith");
  assert.equal(response.statusCode, 200);
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane Smith");
  assert.equal(h.store.contacts["ws-a\0+12025550198"].nameSource, "monday");
  for (const id of [call.callId, older.callId]) {
    const row = h.store.callRows.get(`ws-a\0${id}`);
    assert.equal(row.callerName, "Jane Smith");
    assert.equal(row.callerNameSource, "manual");
  }
});

test("name sync ignores our own write echoing back, older changes, and numbers Symantic never heard from", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item } = await syncedJane(h);
  // The lead we created was named "Jane Doe": its echo is not a rename.
  await renameEvent(h, item, "Jane Doe");
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"], undefined);

  // A rename in Symantic at 12:00 beats a Monday change stamped 11:00.
  h.store.contacts["ws-a\0+12025550198"] = { workspaceId: "ws-a", phoneNumber: "+12025550198", name: "Janet", nameUpdatedAt: new Date(h.clock()).toISOString() };
  await renameEvent(h, item, "Jane Old", new Date(h.clock() - HOUR_MS).toISOString());
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Janet");

  // A row whose number never called is not added to Contacts.
  const stranger = h.monday.addItem(h.board.id, { name: "Stranger", phone: "+12025550777" });
  await renameEvent(h, stranger, "Stranger Danger");
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550777"], undefined);
});

test("renamed in Symantic: the caller's row is renamed on each mapped board once, and its echo is ignored", async () => {
  const h = await twoAgentsOneBoard();
  const { item } = await syncedJane(h);
  h.monday.reset();
  await h.runtime.enqueue({ kind: "name-to-monday", workspaceId: "ws-a", provider: "monday", phone: "+12025550198", name: "Jane Q. Public" });
  await h.drain();
  assert.equal(h.monday.items.get(String(item.id)).name, "Jane Q. Public");
  assert.equal(h.monday.count("update_fields"), 1, "the shared board is renamed once, not once per agent");
  // Monday reports that rename back: nothing changes.
  h.store.contacts["ws-a\0+12025550198"] = { workspaceId: "ws-a", phoneNumber: "+12025550198", name: "Jane Q. Public", nameUpdatedAt: new Date(h.clock()).toISOString() };
  await renameEvent(h, item, "Jane Q. Public");
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].nameSource, undefined, "still Symantic's own rename");
});

test("the BFF's contact-renamed notice queues the push to Monday", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item } = await syncedJane(h);
  const handler = createHandler({ getRuntime: async () => h.runtime });
  const result = await handler({ action: "contact-renamed", workspaceId: "ws-a", phone: "+12025550198", name: "Jane Renamed" });
  assert.equal(result.status, "queued");
  await h.drain();
  assert.equal(h.monday.items.get(String(item.id)).name, "Jane Renamed");
});

test("a connection without the webhook permission: no webhooks, but a reconnect catches up names", async () => {
  const h = createHarness();
  h.monday.grantScope("me:read account:read boards:read boards:write updates:write users:read");
  await h.connectAndMap();
  assert.equal(h.monday.webhooks.size, 0);
  assert.equal(JSON.parse((await h.api("GET", "/crm/connection", { sub: "sub-admin-a" })).body).nameSync, "renew");
  const { call, item } = await syncedJane(h);
  item.name = "Jane Later";
  item.updatedAt = new Date(h.clock()).toISOString();
  // No polling: nothing changes until the connection is (re)set up.
  h.clock.advance(3 * HOUR_MS);
  await h.runtime.refreshTokens();
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"], undefined);
  // Renewing (now with the permission) registers webhooks and catches up.
  h.monday.grantScope("me:read account:read boards:read boards:write updates:write users:read webhooks:write");
  await h.connect();
  await h.drain();
  assert.equal(webhooksOn(h, h.board.id).length, 1);
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane Later");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).callerName, "Jane Later");
});

test("after a disconnect, a reconnect catches up renames made on either side meanwhile", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item: jane } = await syncedJane(h);
  const bobCall = h.seedCall({ callerNumber: "+12025550111", callerName: "Bob" });
  h.enqueueCall(bobCall);
  await h.drain();
  const bob = h.monday.items.get(String(h.store.callRows.get(`ws-a\0${bobCall.callId}`).crmItemId));
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });

  h.clock.advance(60_000);
  jane.name = "Jane From Monday"; // renamed in Monday while disconnected
  jane.updatedAt = new Date(h.clock()).toISOString();
  h.clock.advance(60_000);
  h.store.contacts["ws-a\0+12025550111"] = { // renamed in Symantic while disconnected
    workspaceId: "ws-a", phoneNumber: "+12025550111", name: "Robert Symantic", nameSource: "symantic", nameUpdatedAt: new Date(h.clock()).toISOString(),
  };

  await h.connect();
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane From Monday");
  assert.equal(h.monday.items.get(String(bob.id)).name, "Robert Symantic");
});

test("catch-up: a row still showing the name we wrote never overrides a newer Symantic rename", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item } = await syncedJane(h);
  // Symantic renamed Jane; later an unrelated column changed on her row in
  // Monday (so the row looks newer), but the row's name is still ours.
  h.store.contacts["ws-a\0+12025550198"] = {
    workspaceId: "ws-a", phoneNumber: "+12025550198", name: "Jane Symantic", nameSource: "symantic", nameUpdatedAt: new Date(h.clock()).toISOString(),
  };
  h.clock.advance(60_000);
  item.updatedAt = new Date(h.clock()).toISOString();
  await h.runtime.enqueue({ kind: "name-catch-up", workspaceId: "ws-a", provider: "monday#agent-a" });
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane Symantic");
  assert.equal(h.monday.items.get(String(item.id)).name, "Jane Symantic", "Monday follows Symantic");
});

test("the daily check re-creates a webhook removed in Monday and catches up what was missed", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item } = await syncedJane(h);
  await h.runtime.refreshTokens(); // first keeper pass stamps the connection
  h.monday.webhooks.clear(); // someone removed it in Monday
  item.name = "Jane Unheard"; // and this rename never reached us
  item.updatedAt = new Date(h.clock()).toISOString();
  for (let i = 0; i < 145; i += 1) { // a day of 10-minute keeper runs
    h.clock.advance(10 * 60 * 1000);
    await h.runtime.refreshTokens();
  }
  await h.drain();
  assert.equal(webhooksOn(h, h.board.id).length, 1, "re-created");
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane Unheard");
});

test("background jobs offline for a while: the next keeper pass catches up names", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const { item } = await syncedJane(h);
  await h.runtime.refreshTokens();
  h.clock.advance(3 * HOUR_MS); // nothing ran for 3 hours
  item.name = "Jane During Outage";
  item.updatedAt = new Date(h.clock()).toISOString();
  await h.runtime.refreshTokens();
  await h.drain();
  assert.equal(h.store.contacts["ws-a\0+12025550198"].name, "Jane During Outage");
});

// ============================================ Part L: simplified customer board ====

const customerRows = (h) => [...h.monday.items.values()].filter((item) => item.boardId === String(h.board.id) && item.state === "active");
function clientLinkOf(h, call) {
  const connection = h.store.connections.get("ws-a\0monday#agent-a");
  const row = h.monday.items.get(String(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId));
  return row?.values?.[connection.callsBoard.clientColumn?.id]?.linkedIds ?? null;
}

test("setup: the customer board needs a phone column; columns for the AI are optional and checked", async () => {
  const h = createHarness();
  await h.connect();
  const put = (mapping) => h.api("PUT", "/crm/mapping", { sub: "sub-admin-a", body: { mapping } });
  const noPhone = await put({ boardId: h.board.id, columns: {}, readColumns: [] });
  assert.equal(noPhone.statusCode, 422);
  assert.equal(body(noPhone).problems[0].field, "phone");
  const wrongType = await put({ boardId: h.board.id, columns: { phone: { id: "text_outcome" } }, readColumns: [] });
  assert.equal(body(wrongType).problems[0].code, "wrong_type");
  const tooMany = await put({ boardId: h.board.id, columns: { phone: { id: "phone_mkx1" } }, readColumns: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(tooMany.statusCode, 400);
  const gone = await put({ boardId: h.board.id, columns: { phone: { id: "phone_mkx1" } }, readColumns: ["no_such_column"] });
  assert.match(body(gone).problems[0].message, /the AI reads was deleted/);
  const ok = await put({ boardId: h.board.id, columns: { phone: { id: "phone_mkx1" } }, readColumns: ["person", "lead_status"] });
  assert.equal(ok.statusCode, 200);
  const saved = h.store.connections.get("ws-a\0monday#agent-a").mapping;
  assert.deepEqual(saved.readColumns.map((c) => c.title), ["Owner", "Status"], "titles come from the live board");
});

test("lookup: the AI gets the caller's name plus the columns picked for it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane Doe", phone: "2025550198", status: "Qualified", owner: "Sam Lee" });
  const result = await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  assert.equal(result.status, "found");
  assert.match(result.context, /name on file: Jane Doe; Owner: Sam Lee; Status: Qualified/);
  assert.equal(h.store.links.get(`ws-a\0${boardLinkKeyFor("monday#agent-a", h.board.id, "+12025550198")}`).externalId, jane.id);
});

test("a new caller: a row with just name and phone on the customer board, and the call is linked to it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall({ outcome: "lead" });
  h.enqueueCall(call);
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.equal(row.crmCreated, true);
  const customer = h.monday.items.get(row.crmItemId);
  assert.equal(customer.name, "Jane Doe");
  assert.deepEqual(Object.keys(customer.values), ["phone_mkx1"], "only the phone is written");
  assert.equal(customer.updates.length, 1, "one short call summary as an Update");
  assert.match(customer.updates[0].text, /AI receptionist call/);
  assert.match(customer.updates[0].text, /Summary:/);
  assert.match(customer.updates[0].text, /Open this call in Symantic AI/);
  assert.deepEqual(clientLinkOf(h, call), [String(customer.id)]);
});

test("an existing customer: nothing on their row changes; the call is linked to it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane Doe", phone: "+12025550198", status: "Qualified", owner: "Sam Lee" });
  const before = JSON.stringify(jane.values);
  const call = h.seedCall({ outcome: "booked" });
  h.enqueueCall(call);
  await h.drain();
  assert.equal(JSON.stringify(jane.values), before, "no column on the row changes");
  assert.equal(jane.updates.length, 1, "just the call summary Update");
  assert.deepEqual(clientLinkOf(h, call), [String(jane.id)]);
  assert.equal(customerRows(h).length, 1);
});

test("the Symantic AI Calls board still gets every call detail, plus the Client link", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const { connection, board } = callsBoardOf(h);
  const row = h.monday.items.get(String(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId));
  for (const key of ["phone", "summary", "intent", "recording", "callId"]) {
    assert.ok(row.values[connection.callsBoard.columns[key]], `${key} still filled`);
  }
  assert.equal(board.columns.filter((c) => c.title === "Client").length, 1);
});

test("duplicates: the same new caller calling repeatedly, or delivered twice, gets one customer row", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const calls = [h.seedCall(), h.seedCall(), h.seedCall()];
  const results = await Promise.allSettled(calls.map((call) => h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId })));
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "lease_busy"));
  for (const call of calls) { h.enqueueCall(call); h.enqueueCall(call); }
  await h.drain();
  assert.equal(customerRows(h).length, 1);
  for (const call of calls) assert.deepEqual(clientLinkOf(h, call), [customerRows(h)[0].id]);
  assert.equal(customerRows(h)[0].updates.length, 3, "one summary per call, never repeated");
});

test("a customer row deleted in Monday is found or added again, and the call is linked to it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.runtime.lookup({ workspaceId: "ws-a", agentId: "agent-a", callerNumber: "+12025550198" });
  h.monday.deleteItem(jane.id);
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.notEqual(row.crmItemId, jane.id);
  assert.deepEqual(clientLinkOf(h, call), [String(row.crmItemId)]);
});

test("saving the customer board links calls already on the calls board, once, to existing customers", async () => {
  const h = createHarness();
  await h.connect();
  const known = h.seedCall({ callerNumber: "+12025550198" });
  const unknown = h.seedCall({ callerNumber: "+12025550777" });
  for (const call of [known, unknown]) h.enqueueCall(call);
  await h.drain();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.configureMapping();
  await h.drain();
  assert.deepEqual(clientLinkOf(h, known), [String(jane.id)]);
  assert.equal(clientLinkOf(h, unknown), null, "unknown callers get a row on their next call");
  assert.equal(customerRows(h).length, 1, "nothing added for past calls");
});

test("a follow-up edited after the call updates the calls board only", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const customer = h.monday.items.get(h.store.callRows.get(`ws-a\0${call.callId}`).crmItemId);
  const before = JSON.stringify(customer.values);
  h.store.callRows.get(`ws-a\0${call.callId}`).followUp = { status: "in_progress", comment: "Call back Friday" };
  const result = await h.runtime.syncFollowUp({ workspaceId: "ws-a", callId: call.callId });
  assert.equal(result.status, "synced");
  assert.equal(JSON.stringify(customer.values), before);
  const { connection } = callsBoardOf(h);
  const callsRow = h.monday.items.get(String(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId));
  assert.match(callsRow.values[connection.callsBoard.columns.followUp].text, /Call back Friday/);
});

test("the phone column deleted in Monday is flagged within the hour; restoring it re-sends the calls it missed", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const phone = h.board.columns.find((c) => c.id === "phone_mkx1");
  h.monday.removeColumn(h.board.id, "phone_mkx1");
  h.clock.advance(HOUR + 1000);
  await h.runtime.refreshTokens();
  assert.equal(conn(h).mappingStatus, "invalid");
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.ok(h.store.callRows.get(`ws-a\0${call.callId}`).crmCallsItemId, "still logged to the calls board");
  h.board.columns.push(phone);
  h.clock.advance(HOUR + 1000);
  await h.runtime.refreshTokens();
  await h.drain();
  assert.equal(conn(h).mappingStatus, "valid");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

test("the Client column deleted in Monday is added back, and the call is still linked", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const first = h.seedCall();
  h.enqueueCall(first);
  await h.drain();
  const { connection, board } = callsBoardOf(h);
  h.monday.removeColumn(board.id, connection.callsBoard.clientColumn.id);
  const second = h.seedCall();
  h.enqueueCall(second);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${second.callId}`).crmStatus, "synced");
  assert.equal(conn(h).mappingStatus, "valid", "the customer board isn't blamed");
  assert.ok(clientLinkOf(h, second), "linked through the new Client column");
  assert.equal(callsBoardOf(h).board.columns.filter((c) => c.title === "Client").length, 1);
});
