import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_CRM_CONTEXT } from "./context.mjs";
import { createHandler } from "./index.mjs";
import { linkKeyFor } from "./store.mjs";
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

  const row = h.store.connections.get("ws-a\0monday");
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
  assert.equal((await h.api("POST", "/crm/monday/start", { sub: "sub-member-a", groups: [] })).statusCode, 403);
  assert.equal((await h.api("POST", "/crm/monday/start", {})).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", {})).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", { sub: "sub-disabled" })).statusCode, 401);
  assert.equal((await h.api("GET", "/crm/connection", { sub: "sub-unknown" })).statusCode, 401);
  assert.equal((await h.api("DELETE", "/crm/connection", { sub: "sub-member-a", groups: [] })).statusCode, 403);
  assert.equal((await h.api("PUT", "/crm/mapping", { sub: "sub-member-a", groups: [], body: {} })).statusCode, 403);
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
  const row = h.store.connections.get("ws-a\0monday");
  assert.equal(row.mappingStatus, "valid");
  assert.equal(row.mapping.columns.phone.type, "phone", "a client-supplied type is replaced by Monday's");
  assert.equal(row.mapping.boardName, "Leads");
});

test("mapping: invalid mappings are rejected with specific problems and not saved", async () => {
  const h = createHarness();
  await h.connect();
  const wrong = await h.configureMapping({ overrides: { columns: { phone: { id: "email_mkx2" } } } });
  assert.equal(wrong.statusCode, 422);
  assert.equal(body(wrong).problems[0].code, "wrong_type");
  const badLabel = await h.configureMapping({ overrides: { labels: { newLead: "Nope" } } });
  assert.equal(body(badLabel).problems[0].field, "labels.newLead");
  const badInput = await h.api("PUT", "/crm/mapping", { sub: "sub-admin-a", body: { mapping: { boardId: "not-a-number" } } });
  assert.equal(badInput.statusCode, 400);
  assert.equal(h.store.connections.get("ws-a\0monday").mappingStatus, "unconfigured");
});

test("disconnect: revokes at Monday, deletes our tokens, keeps the mapping for reconnect", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const response = await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).connectionState, "disconnected");
  assert.equal(h.monday.revoked.length, 1);
  const row = h.store.connections.get("ws-a\0monday");
  assert.equal(row.encryptedAccessToken, undefined);
  assert.equal(row.encryptedRefreshToken, undefined);
  assert.ok(row.mapping);

  h.monday.reset();
  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
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
  assert.equal(h.store.connections.get("ws-a\0monday").encryptedRefreshToken, undefined);
});

test("reconnect after re-authorization keeps the mapping, revalidates it, and retries failed syncs", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.revokeAll();
  h.monday.expireAccessTokens();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "reauth_required");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "failed");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmLastErrorCode, "reauth_required");

  const view = body(await h.api("GET", "/crm/connection", { sub: "sub-admin-a" }));
  assert.equal(view.connectionState, "reauth_required");
  assert.equal(view.reauthorizeBy, null);

  const { callback } = await h.connect();
  assert.match(callback.headers.location, /crm=connected/);
  const row = h.store.connections.get("ws-a\0monday");
  assert.equal(row.connectionState, "connected");
  assert.equal(row.mappingStatus, "valid");
  assert.equal(h.queue.messages.length, 1, "the failed call was re-queued");
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

// ================================================================ lookup ====

test("lookup: an existing caller gets CRM context in one Monday call", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane Doe", phone: "2025550198", status: "Qualified", owner: "Sam Lee" });
  const result = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(result.status, "found");
  assert.match(result.context, /name on file: Jane Doe; status: Qualified; account owner: Sam Lee/);
  assert.equal(h.monday.graphqlCount(), 1);
  assert.equal(h.store.links.get(`ws-a\0${linkKeyFor("monday", "+12025550198")}`).externalId, jane.id);

  h.monday.reset();
  const again = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(again.status, "found");
  assert.deepEqual(h.monday.requests.map((r) => r.operation), ["get_item"], "a known caller is fetched by id");
  assert.ok(h.metrics.points.some((p) => p.name === "LookupLatency" && p.Outcome === "found"));
});

test("lookup: an unknown caller gets no context and a remembered negative answer", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const result = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550111" });
  assert.equal(result.status, "not_found");
  assert.equal(result.context, NO_CRM_CONTEXT);
  assert.equal(h.store.links.get(`ws-a\0${linkKeyFor("monday", "+12025550111")}`).state, "none");
});

test("lookup: a linked record deleted in Monday falls back to a phone search", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const old = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  h.monday.deleteItem(old.id);
  const replacement = h.monday.addItem(h.board.id, { name: "Jane (new)", phone: "+12025550198" });
  const result = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.match(result.context, /Jane \(new\)/);
  assert.equal(h.store.links.get(`ws-a\0${linkKeyFor("monday", "+12025550198")}`).externalId, replacement.id);
});

test("lookup: Monday slow, down, rate-limited or rejecting never throws and never blocks past the budget", async () => {
  const h = createHarness();
  await h.connectAndMap();

  h.monday.delay("search", 3000);
  const started = Date.now();
  const slow = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  const elapsed = Date.now() - started;
  h.monday.delay("search", 0);
  assert.equal(slow.status, "timeout");
  assert.equal(slow.context, NO_CRM_CONTEXT);
  assert.ok(elapsed < 1500, `lookup gave up after ${elapsed}ms`);

  h.monday.failNext("search", { status: 500, body: {} });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).status, "error");

  h.monday.failNext("search", { status: 429, body: h.monday.errorBody("Rate Limit Exceeded"), headers: { "retry-after": "30" } });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).status, "error");

  h.monday.failNext("search", { status: 200, body: h.monday.errorBody("InvalidColumnIdException") });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).status, "error");
  assert.ok(h.logs.every((entry) => !JSON.stringify(entry).includes("2025550198")), "logs never hold the full number");
});

test("lookup: hitting the daily API cap pauses the connection until the next UTC day", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.failNext("search", { status: 429, body: h.monday.errorBody("DAILY_LIMIT_EXCEEDED") });
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).status, "error");
  const pausedUntil = h.store.connections.get("ws-a\0monday").pausedUntil;
  assert.equal(new Date(pausedUntil).toISOString(), "2026-09-26T00:05:00.000Z");
  h.monday.reset();
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).reason, "paused");
  assert.equal(h.monday.graphqlCount(), 0, "no calls are spent while paused");
  h.clock.set(pausedUntil + 1000);
  h.monday.expireAccessTokens();
  assert.notEqual((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).reason, "paused");
});

test("lookup: an expired access token is refreshed transparently; a revoked grant flips to reauth", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  h.clock.advance(2 * 60 * 60 * 1000);
  const refreshed = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(refreshed.status, "found");
  assert.equal(h.monday.count("oauth_refresh_token"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday").tokenVersion, 2);

  h.monday.revokeAll();
  h.clock.advance(2 * 60 * 60 * 1000);
  const revoked = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(revoked.status, "error");
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "reauth_required");
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).reason, "not_connected");
});

test("lookup: authorization past its six-month ceiling needs reconnecting", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.clock.advance(181 * 86_400_000);
  const result = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(result.context, NO_CRM_CONTEXT);
  assert.equal(h.store.connections.get("ws-a\0monday").reauthReason, "authorization_expired");
});

test("lookup via the Lambda handler (BFF invoke path) returns context and never throws", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const handler = createHandler({ getRuntime: async () => h.runtime });
  const result = await handler({ action: "lookup", workspaceId: "ws-a", callerNumber: "+12025550198" });
  assert.equal(result.status, "found");
  const broken = createHandler({ getRuntime: async () => { throw new Error("no env"); } });
  assert.deepEqual(await broken({ action: "lookup", workspaceId: "ws-a" }), { status: "error", context: NO_CRM_CONTEXT });
  assert.equal((await handler({ foo: 1 })).statusCode, 400);
});

// ================================================================== sync ====

test("sync: an unknown caller becomes a new lead with a call note (3 Monday calls)", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall({ outcome: "lead", toolLog: toolLogFor([{ name: "lead_capture", args: { name: "Jane Doe", email: "jane@example.com", interest: "Whitening" } }]) });
  h.enqueueCall(call);
  await h.drain();

  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.equal(row.crmCreated, true);
  const item = h.monday.items.get(row.crmItemId);
  assert.equal(item.name, "Jane Doe");
  assert.equal(item.values.lead_status.text, "New Lead");
  assert.equal(item.values.person.text, "Priya Shah", "default owner assigned on creation");
  assert.equal(item.values.text_source.text, "AI Receptionist");
  assert.equal(item.values.email_mkx2.text, "jane@example.com");
  assert.equal(item.values.date_follow.text, "2026-09-26", "follow-up is the next local business day");
  assert.equal(item.updates.length, 1);
  assert.match(item.updates[0].text, /New lead captured - follow-up needed/);
  assert.match(item.updates[0].text, /Whitening/);
  assert.match(item.updates[0].text, new RegExp(`Ref: ${call.callId}`));
  assert.deepEqual(h.monday.requests.map((r) => r.operation), ["search", "search", "create_item", "log_call"]);
  assert.ok(h.metrics.sum("SyncSucceeded", { Outcome: "created" }) === 1);
});

test("sync: when the call-time lookup just said 'not found', the worker skips the repeat search", async () => {
  const h = createHarness();
  await h.connectAndMap();
  await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  h.monday.reset();
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.deepEqual(h.monday.requests.map((r) => r.operation), ["create_item", "log_call"]);
});

test("sync: an existing caller gets one combined request - note plus our fields", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane Doe", phone: "+12025550198", status: "Qualified", owner: "Sam Lee" });
  await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  h.monday.reset();

  const call = h.seedCall({
    outcome: "booked",
    toolLog: toolLogFor([{ name: "calendar_create_booking", args: { service: "Cleaning" }, output: { ok: true, startTimeUtc: "2026-09-30T14:00:00.000Z", timezone: "America/New_York" } }]),
  });
  h.enqueueCall(call);
  await h.drain();
  assert.deepEqual(h.monday.requests.map((r) => r.operation), ["log_call_and_fields"], "1 Monday call per returning caller");
  assert.equal(jane.values.date_appt.text, "2026-09-30 14:00:00");
  assert.equal(jane.values.text_outcome.text, "Appointment booked");
  assert.equal(jane.values.lead_status.text, "Qualified", "Monday-owned status untouched");
  assert.equal(jane.values.person.text, "Sam Lee", "Monday-owned owner untouched");
  assert.equal(jane.name, "Jane Doe");
  assert.match(jane.updates[0].text, /Booked Cleaning appointment for Sep 30, 2026, 10:00 AM/);
});

test("sync: follow-up sets the follow-up status and date on an existing lead", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198", status: "Qualified" });
  const call = h.seedCall({ outcome: "message", toolLog: toolLogFor([{ name: "message_take", args: { message: "Please call about my bill" } }]) });
  h.enqueueCall(call);
  await h.drain();
  assert.equal(jane.values.lead_status.text, "Follow up");
  assert.equal(jane.values.date_follow.text, "2026-09-26");
  assert.match(jane.updates[0].text, /Please call about my bill/);
});

test("sync: without a follow-up label configured, an existing status is never changed", async () => {
  const h = createHarness();
  await h.connectAndMap({ overrides: { labels: { newLead: "New Lead", followUp: null } } });
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198", status: "Qualified" });
  const call = h.seedCall({ outcome: "message" });
  h.enqueueCall(call);
  await h.drain();
  assert.equal(jane.values.lead_status.text, "Qualified");
  assert.equal(jane.values.date_follow.text, "2026-09-26");
});

test("sync: cancelling clears only the appointment date we wrote", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const booked = h.seedCall({
    outcome: "booked",
    toolLog: toolLogFor([{ name: "calendar_create_booking", output: { ok: true, startTimeUtc: "2026-09-30T14:00:00.000Z" } }]),
  });
  h.enqueueCall(booked);
  await h.drain();
  assert.ok(jane.values.date_appt);

  h.clock.advance(60 * 60 * 1000);
  const cancelOther = h.seedCall({
    endedAt: new Date(h.clock() - 1000).toISOString(),
    toolLog: toolLogFor([{ name: "calendar_cancel_booking", output: { ok: true, startTimeUtc: "2026-10-05T14:00:00.000Z" } }]),
  });
  h.enqueueCall(cancelOther);
  await h.drain();
  assert.ok(jane.values.date_appt, "a different appointment's cancellation leaves our date alone");

  h.clock.advance(60 * 60 * 1000);
  const cancel = h.seedCall({
    endedAt: new Date(h.clock() - 1000).toISOString(),
    toolLog: toolLogFor([{ name: "calendar_cancel_booking", output: { ok: true, startTimeUtc: "2026-09-30T14:00:00.000Z" } }]),
  });
  h.enqueueCall(cancel);
  await h.drain();
  assert.equal(jane.values.date_appt, undefined);
  assert.equal(jane.updates.length, 3);
});

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

test("duplicates: the same call delivered many times yields one lead and one note", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  for (let i = 0; i < 4; i += 1) h.enqueueCall(call);
  await h.drain();
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].updates.length, 1);
  assert.ok(h.metrics.sum("SyncDuplicate") >= 1);
});

test("duplicates: two calls from the same new number processed concurrently create one lead", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const first = h.seedCall();
  const second = h.seedCall({ endedAt: new Date(h.clock() - 30_000).toISOString() });
  h.enqueueCall(first);
  h.enqueueCall(second);
  // Both messages arrive in one batch; the lease forces the second to wait.
  await h.drain();
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].updates.length, 2);
  assert.equal(h.store.callRows.get(`ws-a\0${first.callId}`).crmItemId, leads[0].id);
  assert.equal(h.store.callRows.get(`ws-a\0${second.callId}`).crmItemId, leads[0].id);
});

test("duplicates: truly parallel workers on the same number still create one lead", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const calls = [h.seedCall(), h.seedCall(), h.seedCall()];
  const results = await Promise.allSettled(calls.map((call) =>
    h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId })
  ));
  const failed = results.filter((r) => r.status === "rejected");
  assert.ok(failed.every((r) => r.reason.code === "lease_busy"), "losers back off with lease_busy");
  for (const call of calls) h.enqueueCall(call);
  await h.drain();
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].updates.length, 3);
});

test("duplicates: the same message delivered to two workers at once yields one lead and one note", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  const results = await Promise.allSettled([
    h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId }),
    h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId }),
  ]);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "lease_busy").length, 1,
    "the second delivery waits for the lease");
  h.enqueueCall(call);
  await h.drain();
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].updates.length, 1);
});

test("a failure writing the in-progress marker still releases the phone lease", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.store.failNext("updateCallSync", Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
  await assert.rejects(h.runtime.sync.syncCall({ workspaceId: "ws-a", callId: call.callId }));
  const link = h.store.links.get(`ws-a\0${linkKeyFor("monday", "+12025550198")}`);
  assert.equal(link.leaseOwner, undefined, "lease released");
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
});

test("duplicates: Monday commits create_item but the response is lost - the retry reuses it", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.monday.failNext("create_item", { afterEffect: true, status: 502 });
  h.enqueueCall(call);
  await h.drain({ advanceMs: 60_000 });
  const leads = [...h.monday.items.values()].filter((item) => item.boardId === h.board.id);
  assert.equal(leads.length, 1, "no duplicate lead");
  assert.equal(leads[0].updates.length, 1);
  // The "creating" marker makes the retry search before creating again.
  assert.equal(h.monday.count("create_item"), 1);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
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

test("duplicates: a note committed but unacknowledged, retried after the 30-minute window, is not re-posted", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const call = h.seedCall();
  h.monday.failNext("log_call_and_fields", { afterEffect: true, status: 504 });
  h.enqueueCall(call);
  const event = h.queue.receive();
  h.queue.settle(event, await h.worker(event));
  assert.equal(jane.updates.length, 1);
  h.clock.advance(40 * 60 * 1000);
  await h.drain();
  assert.equal(jane.updates.length, 1, "found our Ref: note instead of posting a second one");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.ok(h.monday.requests.some((r) => r.operation === "find_update"));
});

test("out-of-order: an older call processed after a newer one never overwrites newer fields", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  const older = h.seedCall({ endedAt: "2026-09-25T10:00:00.000Z", outcome: "answered" });
  const newer = h.seedCall({
    endedAt: "2026-09-25T14:00:00.000Z",
    outcome: "booked",
    toolLog: toolLogFor([{ name: "calendar_create_booking", output: { ok: true, startTimeUtc: "2026-10-01T15:00:00.000Z" } }]),
  });
  h.enqueueCall(newer);
  await h.drain();
  h.enqueueCall(older);
  await h.drain();
  assert.equal(jane.values.text_outcome.text, "Appointment booked", "outcome from the newest call");
  assert.equal(jane.values.date_last.text, "2026-09-25 14:00:00");
  assert.equal(jane.updates.length, 2, "the older call's note is still recorded");
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
  assert.equal(h.monday.graphqlCount(), 1, "the second message did not spend a call while paused");
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
  assert.equal(h.store.connections.get("ws-a\0monday").lastSyncStatus, "failed");

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
  assert.equal((await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" })).status, "skipped");
  assert.equal(h.monday.graphqlCount(), 0);
});

test("drift: a removed column still records the note, flags the mapping, and fixing it retries", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  h.monday.removeColumn(h.board.id, "text_outcome");
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(jane.updates.length, 1, "the note landed");
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.equal(h.store.connections.get("ws-a\0monday").mappingStatus, "invalid");

  const fixed = await h.configureMapping({
    overrides: { columns: { ...h.store.connections.get("ws-a\0monday").mapping.columns, outcome: undefined } },
  });
  assert.equal(fixed.statusCode, 200);
  assert.equal(h.store.connections.get("ws-a\0monday").mappingStatus, "valid");
});

test("drift: a status label deleted in Monday is an invalid value, not an endless retry", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.board.columns.find((c) => c.id === "lead_status").labels = ["Working on it"];
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  assert.equal(h.queue.dlq.length, 0);
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmLastErrorCode, "invalid_value");
});

test("drift: a linked record deleted in Monday is re-resolved and a new lead is created", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const jane = h.monday.addItem(h.board.id, { name: "Jane", phone: "+12025550198" });
  await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
  h.monday.deleteItem(jane.id);
  const call = h.seedCall();
  h.enqueueCall(call);
  await h.drain();
  const row = h.store.callRows.get(`ws-a\0${call.callId}`);
  assert.equal(row.crmStatus, "synced");
  assert.notEqual(row.crmItemId, jane.id);
  assert.equal(h.monday.items.get(row.crmItemId).updates.length, 1);
  assert.equal(h.metrics.sum("StaleLink"), 1);
});

test("retry endpoint: re-queues recent failures once the mapping is fixed", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const call = h.seedCall();
  h.board.columns.find((c) => c.id === "lead_status").labels = ["Working on it"];
  h.enqueueCall(call);
  await h.drain();
  h.board.columns.find((c) => c.id === "lead_status").labels = ["New Lead", "Follow up"];
  const retry = await h.api("POST", "/crm/sync/retry", { sub: "sub-admin-a" });
  assert.equal(body(retry).requeued, 1);
  await h.drain();
  assert.equal(h.store.callRows.get(`ws-a\0${call.callId}`).crmStatus, "synced");
  assert.equal((await h.api("POST", "/crm/sync/retry", { sub: "sub-admin-a" })).body, JSON.stringify({ requeued: 0 }));
});

// ======================================================= token lifecycle ====

test("tokens: concurrent refreshes in two containers rotate the refresh token exactly once", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.clock.advance(2 * 60 * 60 * 1000);
  const connection = h.store.connections.get("ws-a\0monday");
  const [a, b] = await Promise.all([
    h.runtime.sessions.accessTokenFor(structuredClone(connection)),
    h.runtime.sessions.accessTokenFor(structuredClone(connection)),
  ]);
  assert.equal(a, b);
  assert.equal(h.monday.count("oauth_refresh_token"), 1);
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "connected");
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
  const row = h.store.connections.get("ws-a\0monday");
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

test("webhook: a verified uninstall disconnects every workspace on that Monday account only", async () => {
  const h = createHarness();
  await h.connectAndMap();
  h.store.seedConnection({ workspaceId: "ws-b", provider: "monday", accountId: "999", connectionState: "connected" });
  const response = await lifecycle(h);
  assert.equal(response.statusCode, 200);
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "disconnected");
  assert.equal(h.store.connections.get("ws-a\0monday").disconnectReason, "app_uninstalled");
  assert.equal(h.store.connections.get("ws-a\0monday").encryptedRefreshToken, undefined);
  assert.equal(h.store.connections.get("ws-b\0monday").connectionState, "connected");
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
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "connected");
  assert.equal(h.metrics.sum("Webhook", { Outcome: "rejected" }), 6);
});

test("webhook: other lifecycle events are acknowledged without side effects", async () => {
  const h = createHarness();
  await h.connectAndMap();
  assert.equal((await lifecycle(h, { type: "install" })).statusCode, 200);
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "connected");
});

// ====================================================== tenant isolation ====

test("isolation: each workspace sees and configures only its own connection", async () => {
  const h = createHarness();
  await h.connectAndMap();
  const other = await h.api("GET", "/crm/connection", { sub: "sub-admin-b" });
  assert.equal(other.body, "null");
  assert.equal((await h.api("DELETE", "/crm/connection", { sub: "sub-admin-b" })).body, "null");
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "connected");
  assert.equal((await h.api("GET", "/crm/monday/boards", { sub: "sub-admin-b" })).statusCode, 409);
  const lookup = await h.runtime.lookup({ workspaceId: "ws-b", callerNumber: "+12025550198" });
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
  assert.deepEqual(fresh, { connected: 1, refreshed: 0, fresh: 1, failed: 0 }, "a new token is left alone");

  h.clock.advance(40 * 60 * 1000);
  const due = await h.runtime.refreshTokens();
  assert.equal(due.refreshed, 1);
  assert.equal(h.monday.count("oauth_refresh_token"), 1);

  h.clock.advance(30 * 60 * 1000);
  h.monday.reset();
  const lookup = await h.runtime.lookup({ workspaceId: "ws-a", callerNumber: "+12025550198" });
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
  assert.equal(h.store.connections.get("ws-a\0monday").connectionState, "reauth_required");
  assert.equal(h.metrics.sum("KeeperFailed"), 1);
});

test("keeper: skips disconnected workspaces and never touches their tokens", async () => {
  const h = createHarness();
  await h.connectAndMap();
  await h.api("DELETE", "/crm/connection", { sub: "sub-admin-a" });
  h.clock.advance(55 * 60 * 1000);
  assert.deepEqual(await h.runtime.refreshTokens(), { connected: 0, refreshed: 0, fresh: 0, failed: 0 });
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
  assert.deepEqual(await handler({ action: "refresh-tokens" }), { connected: 1, refreshed: 0, fresh: 1, failed: 0 });
});
