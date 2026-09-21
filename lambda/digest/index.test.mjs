import assert from "node:assert/strict";
import test from "node:test";

import { createDigestHandler } from "./index.mjs";
import { createSesSender, describeSendFailure, normalizeEmail } from "./email.mjs";
import { renderNegativeSentimentAlert } from "./render.mjs";
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
    recipients: ["dana@arcdental.com"],
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

function memoryStore({ workspaces = [], calls = [], admins = [], agents = [], claimSucceeds = true, negativeSentimentCalls = [], pendingBookings = [] } = {}) {
  const log = [];
  const state = new Map(workspaces.map((workspace) => [workspace.workspaceId, { ...workspace }]));
  const pendingAlerts = new Map(negativeSentimentCalls.map((item) => [`${item.workspaceId}:${item.callId}`, { ...item }]));
  const pendingBookingAlerts = new Map(pendingBookings.map((item) => [`${item.workspaceId}:${item.callId}`, { ...item }]));
  return {
    log,
    state,
    pendingAlerts,
    pendingBookingAlerts,
    async listDigestWorkspaces() {
      return [...state.values()].filter((workspace) => (
        workspace.callDigest?.enabled === true || workspace.negativeSentimentAlert?.enabled === true
      ));
    },
    async getWorkspace(workspaceId) {
      return state.get(workspaceId) ?? null;
    },
    async listCallsAnalyzedBetween(workspaceId, start, end) {
      log.push(["listCalls", workspaceId, start, end]);
      if (workspaceId === "broken") throw new Error("boom");
      return calls.filter((item) => item.analyzedAt > start && item.analyzedAt <= end);
    },
    async listPendingNegativeSentimentCalls(workspaceId) {
      log.push(["listPendingNegativeSentimentCalls", workspaceId]);
      return [...pendingAlerts.values()].filter((item) => item.workspaceId === workspaceId);
    },
    async markNegativeSentimentAlerted(workspaceId, callId) {
      log.push(["markNegativeSentimentAlerted", workspaceId, callId]);
      pendingAlerts.delete(`${workspaceId}:${callId}`);
      return true;
    },
    async listPendingBookingAlerts(workspaceId) {
      log.push(["listPendingBookingAlerts", workspaceId]);
      return [...pendingBookingAlerts.values()].filter((item) => item.workspaceId === workspaceId);
    },
    async markBookingAlerted(workspaceId, callId) {
      log.push(["markBookingAlerted", workspaceId, callId]);
      pendingBookingAlerts.delete(`${workspaceId}:${callId}`);
      return true;
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

test("a due summary goes to every configured recipient, once each", async () => {
  const store = memoryStore({
    workspaces: [workspace({
      callDigest: settings({ recipients: ["Frontdesk@ArcDental.com", "dana@arcdental.com", "sam@arcdental.com", "dana@arcdental.com"] }),
    })],
    calls: [call()],
    agents: [{ agentId: "agent-1", name: "Maya" }],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { sent: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
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
  // A history entry is recorded alongside the send, with the full
  // plain-text body (not just the subject line) so Notification History
  // can show what was actually sent.
  const [notification] = store.state.get("ws-1").notifications;
  assert.equal(notification.content, message.text);
  assert.match(notification.content, /1 new call since your last check/);
  assert.deepEqual(notification.recipients.sort(), ["dana@arcdental.com", "frontdesk@arcdental.com", "sam@arcdental.com"]);
  assert.equal(notification.read, false);
});

test("an interval with no calls sends nothing but still moves the window on", async () => {
  const store = memoryStore({ workspaces: [workspace()], calls: [], admins: ["dana@arcdental.com"] });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { no_calls: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
  assert.equal(store.state.get("ws-1").notifications, undefined);
  assert.equal(sender.sent.length, 0);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
});

test("skipIfEmpty:false sends a confirmation even when there are zero calls", async () => {
  const store = memoryStore({
    workspaces: [workspace({ callDigest: settings({ skipIfEmpty: false }) })],
    calls: [],
    admins: ["dana@arcdental.com"],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { sent: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].html, /No new calls since your last check/);
  const run = store.state.get("ws-1").callDigestLastRun;
  assert.equal(run.status, "sent");
  assert.equal(run.callCount, 0);
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

  assert.deepEqual(results, { not_due: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
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

  assert.deepEqual(results, { initialized: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
  assert.equal(sender.sent.length, 0);
  assert.equal(store.state.get("ws-1").callDigestCursor, NOW.toISOString());
});

test("when nobody could be emailed, the window is handed back for the next run", async () => {
  const store = memoryStore({ workspaces: [workspace()], calls: [call()], admins: ["dana@arcdental.com"] });
  const sender = recordingSender({ failFor: ["dana@arcdental.com"] });
  const previous = store.state.get("ws-1").callDigestCursor;

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results, { failed: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
  assert.equal(store.state.get("ws-1").callDigestCursor, previous);
  assert.equal(store.state.get("ws-1").callDigestLastRun.status, "failed");
  assert.match(store.state.get("ws-1").callDigestLastRun.error, /verified addresses/);
});

test("a partial failure still counts as sent and reports what failed", async () => {
  const store = memoryStore({
    workspaces: [workspace({ callDigest: settings({ recipients: ["dana@arcdental.com", "sam@arcdental.com"] }) })],
    calls: [call()],
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

  assert.deepEqual(results, { claimed_elsewhere: 1, negativeSentimentAlerts: { disabled: 1 }, bookingAlerts: { no_calls: 1 } });
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

  assert.deepEqual(results, { error: 1, sent: 1, negativeSentimentAlerts: { disabled: 2 }, bookingAlerts: { no_calls: 2 } });
});

// --- negative-sentiment alerts ----------------------------------------------

function negativeCall(overrides = {}) {
  return {
    workspaceId: "ws-1",
    callId: "call-neg-1",
    callerName: "Jordan Miles",
    callerNumber: "+17035550123",
    startedAt: hoursBefore(0.2),
    callSummary: "Caller was upset about a billing error.",
    transcript: [
      { speaker: "Agent", text: "Thanks for calling Arc Dental." },
      { speaker: "Caller", text: "I was charged twice and nobody has fixed it." },
    ],
    ...overrides,
  };
}

test("a workspace with negative-sentiment alerts on (even with call-digest off) sends one email per pending call and marks each", async () => {
  const store = memoryStore({
    workspaces: [
      workspace({
        callDigest: settings({ enabled: false }),
        negativeSentimentAlert: { enabled: true, recipients: ["dana@arcdental.com"] },
      }),
    ],
    negativeSentimentCalls: [negativeCall(), negativeCall({ callId: "call-neg-2" })],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results.negativeSentimentAlerts, { sent: 1 });
  assert.equal(sender.sent.length, 2);
  assert.ok(sender.sent.every((message) => message.to === "dana@arcdental.com"));
  assert.ok(sender.sent.every((message) => message.subject.includes("Jordan Miles")));
  assert.ok(sender.sent.every((message) => message.attachment?.filename?.endsWith(".txt")));
  assert.ok(sender.sent[0].text.includes("This alert was sent to: dana@arcdental.com."));
  assert.equal(store.pendingAlerts.size, 0);
  // Both alerts land in Notification History - each call's own entry
  // survives, not just the last one written in the loop.
  const notifications = store.state.get("ws-1").notifications;
  assert.equal(notifications.length, 2);
  assert.deepEqual(new Set(notifications.map((n) => n.id)).size, 2);
  assert.ok(notifications.every((n) => n.recipients.includes("dana@arcdental.com")));
});

test("a pending booking sends a short confirmation email to the call-digest recipients and marks it", async () => {
  const bookingCall = call({
    outcome: "booked",
    bookingSummary: { callerName: "Jordan Miles", service: "On-Site Visit", startTime: hoursBefore(-24) },
    workspaceId: "ws-1",
  });
  const store = memoryStore({
    workspaces: [workspace({ callDigest: settings({ recipients: ["dana@arcdental.com"] }) })],
    pendingBookings: [bookingCall],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results.bookingAlerts, { sent: 1 });
  assert.equal(sender.sent.length, 1);
  const [message] = sender.sent;
  assert.equal(message.to, "dana@arcdental.com");
  assert.match(message.subject, /new booking - Jordan Miles/);
  assert.match(message.text, /Type: On-Site Visit/);
  assert.doesNotMatch(message.text, /transcript/i);
  assert.equal(store.pendingBookingAlerts.size, 0);
});

test("booking alerts are skipped when there are no call-digest recipients configured", async () => {
  const store = memoryStore({
    workspaces: [workspace({ workspaceId: "no-recipients", callDigest: settings({ recipients: [] }) })],
    pendingBookings: [call({ workspaceId: "no-recipients", bookingSummary: { callerName: "Jordan Miles", service: "Quick Call" } })],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  assert.equal(results.bookingAlerts.no_recipients, 1);
  assert.equal(sender.sent.length, 0);
});

test("negative-sentiment alerts are skipped when disabled or when there are no recipients", async () => {
  const store = memoryStore({
    workspaces: [
      workspace({ workspaceId: "off", negativeSentimentAlert: { enabled: false, recipients: ["dana@arcdental.com"] } }),
      workspace({ workspaceId: "no-recipients", callDigest: settings({ enabled: false }), negativeSentimentAlert: { enabled: true, recipients: [] } }),
    ],
    negativeSentimentCalls: [negativeCall({ workspaceId: "no-recipients" })],
  });
  const sender = recordingSender();

  const results = await handlerFor(store, sender)({});

  // "off" workspace's callDigest is enabled (default from workspace()), so
  // it still gets a digest outcome - only the alert side is being checked.
  assert.equal(results.negativeSentimentAlerts.no_recipients, 1);
  assert.equal(sender.sent.length, 0);
});

test("a fully-failed negative-sentiment send leaves the call pending for the next tick", async () => {
  const store = memoryStore({
    workspaces: [
      workspace({
        callDigest: settings({ enabled: false }),
        negativeSentimentAlert: { enabled: true, recipients: ["dana@arcdental.com"] },
      }),
    ],
    negativeSentimentCalls: [negativeCall()],
  });
  const sender = recordingSender({ failFor: ["dana@arcdental.com"] });

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results.negativeSentimentAlerts, { failed: 1 });
  assert.equal(store.pendingAlerts.size, 1);
});

test("a partial failure across multiple recipients still marks the call sent", async () => {
  const store = memoryStore({
    workspaces: [
      workspace({
        callDigest: settings({ enabled: false }),
        negativeSentimentAlert: { enabled: true, recipients: ["dana@arcdental.com", "sam@arcdental.com"] },
      }),
    ],
    negativeSentimentCalls: [negativeCall()],
  });
  const sender = recordingSender({ failFor: ["sam@arcdental.com"] });

  const results = await handlerFor(store, sender)({});

  assert.deepEqual(results.negativeSentimentAlerts, { sent: 1 });
  assert.equal(sender.sent.length, 1);
  assert.equal(store.pendingAlerts.size, 0);
});

test("renderNegativeSentimentAlert caps the inline transcript preview at 500 characters but attaches the full thing", () => {
  const longLine = "Caller: ".padEnd(30, "x") + "a".repeat(600);
  const message = renderNegativeSentimentAlert({
    workspaceName: "Arc Dental",
    call: negativeCall({ transcript: [{ speaker: "Caller", text: longLine }] }),
    recipients: ["dana@arcdental.com", "sam@arcdental.com"],
    timezone: "America/New_York",
    dashboardUrl: "https://agents.example.com/call-history",
  });

  const previewMatch = message.text.match(/Transcript preview:\n([\s\S]*?)\n\nThe full transcript/);
  assert.ok(previewMatch);
  assert.ok(previewMatch[1].length <= 501); // 500 chars + the trailing ellipsis
  assert.ok(message.attachment.content.length > 500);
  assert.ok(message.attachment.filename.includes(negativeCall().callId));
  assert.ok(message.text.includes("This alert was sent to: dana@arcdental.com, sam@arcdental.com."));
  assert.ok(message.text.includes("https://agents.example.com/call-history?callId=call-neg-1"));
  assert.ok(message.subject.includes("Jordan Miles"));
});

test("createSesSender sends a raw MIME message (not Simple content) when an attachment is present", async () => {
  let sentCommand;
  const client = { send: async (command) => { sentCommand = command; return { MessageId: "m-1" }; } };
  class SendEmailCommand {
    constructor(input) { this.input = input; }
  }
  const send = createSesSender({ client, SendEmailCommand, from: "info@example.com" });

  await send({
    to: "dana@arcdental.com",
    subject: "Test",
    html: "<p>hi</p>",
    text: "hi",
    attachment: { filename: "transcript-call-1.txt", content: "full transcript text" },
  });

  assert.ok(sentCommand.input.Content.Raw);
  assert.ok(!sentCommand.input.Content.Simple);
  const raw = new TextDecoder().decode(sentCommand.input.Content.Raw.Data);
  assert.match(raw, /Content-Disposition: attachment; filename="transcript-call-1\.txt"/);
  assert.match(raw, /multipart\/mixed/);

  // No attachment - falls back to the existing Simple content shape unchanged.
  await send({ to: "dana@arcdental.com", subject: "Test", html: "<p>hi</p>", text: "hi" });
  assert.ok(sentCommand.input.Content.Simple);
  assert.ok(!sentCommand.input.Content.Raw);
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
  // A test send shows up in Notification History too, tagged as a test.
  const [notification] = store.state.get("ws-1").notifications;
  assert.equal(notification.test, true);
  assert.deepEqual(notification.recipients, ["dana@arcdental.com"]);
  assert.equal(notification.content, sender.sent[0].text);
});

test("send-negative-sentiment-test uses the workspace's most recent real negative-sentiment call when one exists", async () => {
  const oldOne = { ...negativeCall({ callId: "old-one", startedAt: hoursBefore(5) }), userSentiment: "Negative", analyzedAt: hoursBefore(5) };
  const newest = { ...negativeCall({ callId: "newest", startedAt: hoursBefore(1) }), userSentiment: "Negative", analyzedAt: hoursBefore(1) };
  const store = memoryStore({
    workspaces: [workspace({ callDigest: settings({ enabled: false }) })],
    calls: [oldOne, newest],
    negativeSentimentCalls: [oldOne, newest],
  });
  const sender = recordingSender();

  const result = await handlerFor(store, sender)({
    action: "send-negative-sentiment-test",
    workspaceId: "ws-1",
    recipient: "dana@arcdental.com",
  });

  assert.deepEqual(result, { sent: true, to: "dana@arcdental.com", sample: false });
  assert.equal(sender.sent.length, 1);
  // Still pending (never marked alerted) - a test send must not consume it.
  assert.equal(store.pendingAlerts.size, 2);
  const [notification] = store.state.get("ws-1").notifications;
  assert.equal(notification.test, true);
  assert.deepEqual(notification.recipients, ["dana@arcdental.com"]);
});

test("send-negative-sentiment-test falls back to a synthetic sample call when the workspace has never had a real one", async () => {
  const store = memoryStore({ workspaces: [workspace({ callDigest: settings({ enabled: false }) })] });
  const sender = recordingSender();

  const result = await handlerFor(store, sender)({
    action: "send-negative-sentiment-test",
    workspaceId: "ws-1",
    recipient: "dana@arcdental.com",
  });

  assert.deepEqual(result, { sent: true, to: "dana@arcdental.com", sample: true });
  assert.equal(sender.sent.length, 1);
  assert.match(sender.sent[0].subject, /negative-sentiment call with Jordan Miles/);
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
