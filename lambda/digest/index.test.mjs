import assert from "node:assert/strict";
import test from "node:test";

import { createDigestHandler } from "./index.mjs";
import { describeSendFailure, normalizeEmail } from "./email.mjs";
import { isDigestDue, normalizeDigestSettings } from "./schedule.mjs";

const HOUR = 3_600_000;
// 08:00 in Asia/Kolkata (UTC+5:30), a Tuesday.
const NOW = new Date("2026-09-15T02:30:00.000Z");

function settings(overrides = {}) {
  return normalizeDigestSettings({
    enabled: true,
    frequency: "hourly",
    sendHour: 8,
    weekday: 2,
    timezone: "Asia/Kolkata",
    includeTranscripts: true,
    extraRecipients: [],
    ...overrides,
  });
}

function hoursBefore(hours) {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function call(overrides = {}) {
  return {
    callId: "call-1",
    agentId: "agent-1",
    callerName: "Jordan Miles",
    callerNumber: "+17035550123",
    outcome: "booked",
    startedAt: hoursBefore(0.5),
    analyzedAt: hoursBefore(0.4),
    durationMs: 83_000,
    callSummary: "Booked a cleaning for Thursday at 2 PM.",
    transcript: [
      { speaker: "Agent", text: "Thanks for calling Arc Dental." },
      { speaker: "Caller", text: "I'd like a cleaning <b>Thursday</b>." },
    ],
    ...overrides,
  };
}

function memoryStore({ workspaces = [], calls = [], admins = [], agents = [], claimSucceeds = true } = {}) {
  const log = [];
  const state = new Map(workspaces.map((workspace) => [workspace.workspaceId, { ...workspace }]));
  return {
    log,
    state,
    async listDigestWorkspaces() {
      return [...state.values()].filter((workspace) => workspace.callDigest?.enabled === true);
    },
    async getWorkspace(workspaceId) {
      return state.get(workspaceId) ?? null;
    },
    async listCallsAnalyzedBetween(workspaceId, start, end) {
      log.push(["listCalls", workspaceId, start, end]);
      if (workspaceId === "broken") throw new Error("boom");
      return calls.filter((item) => item.analyzedAt > start && item.analyzedAt <= end);
    },
    async listAgents() {
      return agents;
    },
    async listAdminEmails() {
      return admins;
    },
    async initializeCursor(workspaceId, cursor) {
      log.push(["initializeCursor", workspaceId, cursor]);
      state.get(workspaceId).callDigestCursor ??= cursor;
      return true;
    },
    async claimWindow(workspaceId, expected, next) {
      log.push(["claim", workspaceId, expected, next]);
      if (!claimSucceeds) return false;
      state.get(workspaceId).callDigestCursor = next;
      return true;
    },
    async releaseWindow(workspaceId, claimed, previous) {
      log.push(["release", workspaceId, claimed, previous]);
      state.get(workspaceId).callDigestCursor = previous;
      return true;
    },
    async recordRun(workspaceId, run) {
      log.push(["recordRun", workspaceId, run]);
      state.get(workspaceId).callDigestLastRun = run;
      return true;
    },
    async appendNotification(workspaceId, entry, current) {
      log.push(["appendNotification", workspaceId, entry]);
      state.get(workspaceId).notifications = [entry, ...(current ?? [])].slice(0, 100);
      return true;
    },
  };
}

function recordingSender({ failFor = [] } = {}) {
  const sent = [];
  const send = async (message) => {
    if (failFor.includes(message.to)) {
      const error = new Error("Email address is not verified. The following identities failed the check");
      error.name = "MessageRejected";
      throw error;
    }
    sent.push(message);
    return { messageId: `m-${sent.length}` };
  };
  return { sent, getSender: async () => send };
}

const quietLog = { error() {}, info() {} };

function handlerFor(store, sender) {
  return createDigestHandler({
    getStore: async () => store,
    getSender: sender.getSender,
    appUrl: "https://agents.example.com",
    now: () => NOW,
    log: quietLog,
  });
}

function workspace(overrides = {}) {
  return {
    workspaceId: "ws-1",
    name: "Arc Dental",
    callDigest: settings(),
    callDigestCursor: hoursBefore(1),
    ...overrides,
  };
}

// --- scheduling -------------------------------------------------------------

test("hourly and six-hourly summaries are due once their interval has passed", () => {
  assert.equal(isDigestDue(settings(), hoursBefore(1), NOW), true);
  // EventBridge jitter: a tick a couple of minutes early still counts.
  assert.equal(isDigestDue(settings(), hoursBefore(0.97), NOW), true);
  assert.equal(isDigestDue(settings(), hoursBefore(0.5), NOW), false);
  assert.equal(isDigestDue(settings({ frequency: "every_6_hours" }), hoursBefore(6), NOW), true);
  assert.equal(isDigestDue(settings({ frequency: "every_6_hours" }), hoursBefore(3), NOW), false);
});

test("daily summaries go out at the chosen hour in the business's own timezone", () => {
  const daily = settings({ frequency: "daily", sendHour: 8 });
  assert.equal(isDigestDue(daily, hoursBefore(24), NOW), true);
  // 08:00 IST is 02:30 UTC - a UTC-based check would wrongly say no.
  assert.equal(isDigestDue({ ...daily, sendHour: 2 }, hoursBefore(24), NOW), false);
  // Never twice in one day, even if the hour matches again after a short gap.
  assert.equal(isDigestDue(daily, hoursBefore(2), NOW), false);
});

test("weekly summaries need the right weekday as well as the right hour", () => {
  const weekly = settings({ frequency: "weekly", sendHour: 8, weekday: 2 });
  assert.equal(isDigestDue(weekly, hoursBefore(24 * 7), NOW), true);
  assert.equal(isDigestDue({ ...weekly, weekday: 3 }, hoursBefore(24 * 7), NOW), false);
});

test("a disabled summary, or one without a cursor, is never due", () => {
  assert.equal(isDigestDue(settings({ enabled: false }), hoursBefore(5), NOW), false);
  assert.equal(isDigestDue(settings(), undefined, NOW), false);
});

// --- runs -------------------------------------------------------------------

test("a due summary goes to every admin plus extra addresses, once each", async () => {
  const store = memoryStore({
    workspaces: [workspace({
      callDigest: settings({ extraRecipients: ["Frontdesk@ArcDental.com", "dana@arcdental.com"] }),
    })],
    calls: [call()],
    admins: ["dana@arcdental.com", "sam@arcdental.com"],
    agents: [{ agentId: "agent-1", name: "Maya" }],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { sent: 1 });
  assert.deepEqual(
    sender.sent.map((message) => message.to).sort(),
    ["dana@arcdental.com", "frontdesk@arcdental.com", "sam@arcdental.com"],
  );
  const [message] = sender.sent;
  assert.equal(message.subject, "Arc Dental: 1 new call");
  // The nudge is intentionally content-free: no caller name, summary, or
  // transcript text ever appears in the email body.
  assert.match(message.html, /1 new call since your last check/);
  assert.doesNotMatch(message.html, /Booked a cleaning/);
  assert.doesNotMatch(message.html, /Jordan Miles/);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
  assert.deepEqual(store.state.get("ws-1").callDigestLastRun, {
    at: NOW.toISOString(),
    status: "sent",
    callCount: 1,
    recipientCount: 3,
  });
  // A history entry is recorded alongside the send.
  const [notification] = store.state.get("ws-1").notifications;
  assert.equal(notification.content, "Arc Dental: 1 new call");
  assert.deepEqual(notification.recipients.sort(), ["dana@arcdental.com", "frontdesk@arcdental.com", "sam@arcdental.com"]);
  assert.equal(notification.read, false);
});

test("an interval with no calls sends nothing but still moves the window on", async () => {
  const store = memoryStore({ workspaces: [workspace()], calls: [], admins: ["dana@arcdental.com"] });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { no_calls: 1 });
  assert.equal(store.state.get("ws-1").notifications, undefined);
  assert.equal(sender.sent.length, 0);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
});

test("only calls analyzed inside the window are included", async () => {
  const store = memoryStore({
    workspaces: [workspace()],
    calls: [
      call({ callId: "old", callSummary: "Before the window.", analyzedAt: hoursBefore(2) }),
      call({ callId: "new", callSummary: "Inside the window." }),
    ],
    admins: ["dana@arcdental.com"],
  });
  const sender = recordingSender();

  await handlerFor(store, sender)({});

  // Only the count is content-derived; both calls' summary text is absent
  // from the email either way, but the count must reflect just the one call
  // inside the window.
  assert.match(sender.sent[0].html, /1 new call since your last check/);
});

test("a summary that is not yet due does nothing", async () => {
  const store = memoryStore({
    workspaces: [workspace({ callDigestCursor: hoursBefore(0.25) })],
    calls: [call()],
    admins: ["dana@arcdental.com"],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { not_due: 1 });
  assert.equal(sender.sent.length, 0);
  assert.equal(store.log.some(([kind]) => kind === "claim"), false);
});

test("a workspace without a cursor starts its window now instead of mailing history", async () => {
  const store = memoryStore({
    workspaces: [workspace({ callDigestCursor: undefined })],
    calls: [call({ analyzedAt: hoursBefore(500) })],
    admins: ["dana@arcdental.com"],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { initialized: 1 });
  assert.equal(sender.sent.length, 0);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
});

test("when nobody could be emailed, the window is handed back for the next run", async () => {
  const store = memoryStore({ workspaces: [workspace()], calls: [call()], admins: ["dana@arcdental.com"] });
  const sender = recordingSender({ failFor: ["dana@arcdental.com"] });
  const previous = store.state.get("ws-1").callDigestCursor;

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { failed: 1 });
  assert.equal(store.state.get("ws-1").callDigestCursor, previous);
  assert.equal(store.state.get("ws-1").callDigestLastRun.status, "failed");
  assert.match(store.state.get("ws-1").callDigestLastRun.error, /verified addresses/);
});

test("a partial failure still counts as sent and reports what failed", async () => {
  const store = memoryStore({
    workspaces: [workspace()],
    calls: [call()],
    admins: ["dana@arcdental.com", "sam@arcdental.com"],
  });
  const sender = recordingSender({ failFor: ["sam@arcdental.com"] });

  await handlerFor(store, sender)({});

  const run = store.state.get("ws-1").callDigestLastRun;
  assert.equal(run.status, "sent");
  assert.equal(run.recipientCount, 1);
  assert.equal(run.failedCount, 1);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
});

test("a window claimed by an overlapping run is never sent twice", async () => {
  const store = memoryStore({
    workspaces: [workspace()],
    calls: [call()],
    admins: ["dana@arcdental.com"],
    claimSucceeds: false,
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { claimed_elsewhere: 1 });
  assert.equal(sender.sent.length, 0);
});

test("one workspace failing does not stop the others", async () => {
  const store = memoryStore({
    workspaces: [
      workspace({ workspaceId: "broken" }),
      workspace({ workspaceId: "ws-2" }),
    ],
    calls: [call()],
    admins: ["dana@arcdental.com"],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { error: 1, sent: 1 });
});

test("a test send goes only to the requester and leaves the schedule alone", async () => {
  const store = memoryStore({
    workspaces: [workspace({ callDigest: settings({ enabled: false }) })],
    calls: [call()],
    admins: ["dana@arcdental.com", "sam@arcdental.com"],
  });
  const sender = recordingSender();
  const cursor = store.state.get("ws-1").callDigestCursor;

  const result = await handlerFor(store, sender)({
    action: "send-test",
    workspaceId: "ws-1",
    recipient: "Dana@ArcDental.com",
  });

  assert.deepEqual(result, { sent: true, to: "dana@arcdental.com", callCount: 1 });
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].subject, "Test: Arc Dental notification");
  assert.equal(store.state.get("ws-1").callDigestCursor, cursor);
});

test("a test send reports sandbox rejection in plain language", async () => {
  const store = memoryStore({ workspaces: [workspace()], calls: [] });
  const sender = recordingSender({ failFor: ["new@example.com"] });

  const result = await handlerFor(store, sender)({
    action: "send-test",
    workspaceId: "ws-1",
    recipient: "new@example.com",
  });

  assert.equal(result.sent, false);
  assert.match(result.error, /verified addresses until email access is approved/);
});

test("email helpers reject malformed addresses and header injection", () => {
  assert.equal(normalizeEmail(" Dana@ArcDental.com "), "dana@arcdental.com");
  assert.equal(normalizeEmail("dana@arcdental"), null);
  assert.equal(normalizeEmail("dana@arcdental.com\r\nBcc: x@y.com"), null);
  assert.equal(normalizeEmail("a b@c.com"), null);
  assert.match(describeSendFailure({ name: "Throttling" }), /could not be sent/);
});
