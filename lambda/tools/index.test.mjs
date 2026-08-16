import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createCalendarAdapter } from "./calendar/index.mjs";
import { createGoogleCalendarClient } from "./calendar/google.mjs";
import { createMicrosoftCalendarClient } from "./calendar/microsoft.mjs";
import { providerIdempotencyIds } from "./handlers/records.mjs";
import { createHandler, verifyRetellSignature } from "./index.mjs";

const workspaceId = "workspace-123";
const callId = "call-123";
const signature = "test-signature";

test("duplicate createBooking returns the original appointment without a second provider write", async () => {
  const records = new Map();
  const providerCalls = [];
  const store = createStore({
    getAppointment: async (_workspaceId, appointmentId) =>
      clone(records.get(appointmentId)),
    putAppointment: async (appointment) => {
      if (records.has(appointment.appointmentId)) {
        const error = new Error("exists");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      records.set(appointment.appointmentId, clone(appointment));
      return clone(appointment);
    },
  });
  const calendar = {
    async getAvailability(input) {
      providerCalls.push(["availability", input]);
      return { available: true, busy: [] };
    },
    async createBooking(input) {
      providerCalls.push(["create", input]);
      return {
        providerEventId: "google-event-1",
        provider: "google-calendar",
        htmlLink: "https://calendar.google.com/event/1",
      };
    },
  };
  const handler = toolHandler({ store, calendar });
  const body = bookingBody();

  const first = await handler(event(
    "/retell/tools/calendar.createBooking",
    body,
  ));
  const second = await handler(event(
    "/retell/tools/calendar.createBooking",
    body,
  ));

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.match(JSON.parse(first.body).appointmentId, /^apt-/);
  assert.equal(providerCalls.filter(([name]) => name === "availability").length, 1);
  assert.equal(providerCalls.filter(([name]) => name === "create").length, 1);
  assert.equal(records.size, 1);
});

test("createBooking resolves relative time in the workspace timezone and persists UTC", async () => {
  let persisted;
  let providerInput;
  const store = createStore({
    getBusinessProfile: async () => ({ timezone: "America/New_York" }),
    putAppointment: async (appointment) => {
      persisted = clone(appointment);
      return clone(appointment);
    },
  });
  const calendar = {
    async getAvailability() {
      return { available: true, busy: [] };
    },
    async createBooking(input) {
      providerInput = input;
      return {
        providerEventId: "event-relative",
        provider: "google-calendar",
      };
    },
  };
  const handler = toolHandler({
    store,
    calendar,
    now: () => new Date("2026-08-16T12:00:00.000Z"),
  });

  const response = await handler(event(
    "/retell/tools/calendar.createBooking",
    bookingBody({
      startTime: "tomorrow at 2:00 PM",
      durationMinutes: 45,
      endTime: undefined,
    }),
  ));

  assert.equal(response.statusCode, 200);
  assert.equal(persisted.startTimeUtc, "2026-08-17T18:00:00.000Z");
  assert.equal(persisted.endTimeUtc, "2026-08-17T18:45:00.000Z");
  assert.equal(persisted.timezone, "America/New_York");
  assert.equal(providerInput.startTimeUtc, persisted.startTimeUtc);
});

test("createBooking never persists or confirms when provider write fails", async () => {
  let writes = 0;
  const store = createStore({
    putAppointment: async () => {
      writes += 1;
    },
  });
  const calendar = {
    async getAvailability() {
      return { available: true, busy: [] };
    },
    async createBooking() {
      throw new Error("provider unavailable");
    },
  };
  const handler = toolHandler({ store, calendar });

  const response = await handler(event(
    "/retell/tools/calendar.createBooking",
    bookingBody(),
  ));

  assert.equal(response.statusCode, 502);
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "provider_error",
    message: "I couldn't complete that calendar booking. I can take a message for the office.",
    action: "take_message",
  });
});

test("calendar reauthorization returns a speakable take-message response", async () => {
  const handler = toolHandler({
    calendar: {
      async getAvailability() {
        const error = new Error("Calendar authorization expired");
        error.code = "calendar_reauth_required";
        error.reauthRequired = true;
        throw error;
      },
    },
  });

  const response = await handler(event(
    "/retell/tools/calendar.getAvailability",
    requiredBody({
      startTime: "2026-08-17T14:00:00-04:00",
      endTime: "2026-08-17T14:30:00-04:00",
    }),
  ));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "calendar_reauth_required",
    disableBookingTools: true,
    action: "take_message",
    message: "The calendar needs to be reconnected. I can take a message and have the office follow up.",
  });
});

test("invalid signature returns 401 before body validation or persistence", async () => {
  let storeLoads = 0;
  const handler = createHandler({
    verifySignature: async () => false,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => {
      storeLoads += 1;
      return createStore();
    },
    getCalendar: async () => ({}),
  });

  const response = await handler(event(
    "/retell/tools/lead.capture",
    { arbitrary: "body" },
    "invalid-signature",
  ));

  assert.equal(response.statusCode, 401);
  assert.equal(storeLoads, 0);
});

test("every tool rejects a missing workspaceId, callId, or idempotencyKey", async () => {
  const handler = toolHandler();
  const paths = [
    "/retell/tools/calendar.getAvailability",
    "/retell/tools/calendar.createBooking",
    "/retell/tools/calendar.rescheduleBooking",
    "/retell/tools/calendar.cancelBooking",
    "/retell/tools/lead.capture",
    "/retell/tools/message.take",
    "/retell/tools/call.transfer",
  ];

  for (const path of paths) {
    for (const missing of ["workspaceId", "callId", "idempotencyKey"]) {
      const body = requiredBody();
      delete body[missing];
      const response = await handler(event(path, body));
      assert.equal(response.statusCode, 400, `${path} must require ${missing}`);
      assert.equal(JSON.parse(response.body).code, "invalid_request");
    }
  }
});

test("lead.capture and message.take return their original records for duplicate keys", async () => {
  const leads = new Map();
  const messages = new Map();
  const store = createStore({
    getLead: async (_workspaceId, id) => clone(leads.get(id)),
    putLead: async (record) => putOnce(leads, record.leadId, record),
    getMessage: async (_workspaceId, id) => clone(messages.get(id)),
    putMessage: async (record) => putOnce(messages, record.messageId, record),
  });
  const handler = toolHandler({ store });
  const lead = requiredBody({
    idempotencyKey: "lead-key",
    name: "Jordan Miles",
    phone: "+17035550123",
    email: "jordan@example.com",
    interest: "Emergency exam",
  });
  const message = requiredBody({
    idempotencyKey: "message-key",
    name: "Jordan Miles",
    phone: "+17035550123",
    message: "Please call me after 4 PM.",
  });

  const leadA = await handler(event("/retell/tools/lead.capture", lead));
  const leadB = await handler(event("/retell/tools/lead.capture", lead));
  const messageA = await handler(event("/retell/tools/message.take", message));
  const messageB = await handler(event("/retell/tools/message.take", message));

  assert.equal(JSON.parse(leadA.body).leadId, JSON.parse(leadB.body).leadId);
  assert.equal(JSON.parse(messageA.body).messageId, JSON.parse(messageB.body).messageId);
  assert.equal(leads.size, 1);
  assert.equal(messages.size, 1);
  assert.equal(JSON.parse(leadA.body).message, "We will notify the office.");
  assert.equal(JSON.parse(messageA.body).message, "We will notify the office.");
});

test("call.transfer reads agent emergency policy before profile fallbacks", async () => {
  const store = createStore({
    getAgent: async () => ({
      configuration: {
        escalation: "For emergencies call +17035550177 immediately.",
      },
    }),
    getBusinessProfile: async () => ({
      escalationContact: "Office manager +17035550199",
      ownerPhone: "+17035550100",
      fallbackPhone: "+17035550188",
    }),
  });
  const handler = toolHandler({ store });

  const response = await handler(event(
    "/retell/tools/call.transfer",
    requiredBody({ agentId: "agent-1", reason: "medical emergency" }),
  ));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    action: "transfer",
    transferTarget: "+17035550177",
    message: "Please hold while I connect you.",
  });
});

test("Retell verifier checks timestamped HMAC and rejects stale signatures", async () => {
  const body = '{"workspaceId":"workspace-123"}';
  const apiKey = "retell-key";
  const timestamp = 1_800_000_000_000;
  const digest = createHmac("sha256", apiKey)
    .update(body + timestamp)
    .digest("hex");

  assert.equal(
    verifyRetellSignature(
      body,
      apiKey,
      `v=${timestamp},d=${digest}`,
      { now: () => timestamp + 1_000 },
    ),
    true,
  );
  assert.equal(
    verifyRetellSignature(
      body,
      apiKey,
      `v=${timestamp},d=${digest}`,
      { now: () => timestamp + 5 * 60_000 + 1 },
    ),
    false,
  );
});

test("adapter marks the calendar reauth_required on invalid_grant", async () => {
  let reauth;
  const adapter = createCalendarAdapter({
    connectionStore: {
      async get() {
        return {
          workspaceId,
          provider: "google-calendar",
          selectedCalendarId: "calendar-a",
          calendarTimezone: "America/New_York",
          encryptedRefreshToken: "encrypted-token",
          tokenVersion: 1,
          connectionState: "connected",
        };
      },
      async markReauthRequired(id, reason) {
        reauth = { id, reason };
      },
    },
    decryptToken: async () => "refresh-token",
    getOAuthSecret: async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      error: "invalid_grant",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    adapter.getAvailability({
      workspaceId,
      startTimeUtc: "2026-08-17T18:00:00.000Z",
      endTimeUtc: "2026-08-17T18:30:00.000Z",
      timezone: "America/New_York",
    }),
    (error) => error.code === "calendar_reauth_required",
  );
  assert.deepEqual(reauth, { id: workspaceId, reason: "invalid_grant" });
});

test("Google adapter sends free/busy and creates an event with a stable provider id", async () => {
  const requests = [];
  const client = createGoogleCalendarClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/freeBusy")) {
        return jsonResponse({
          calendars: { "calendar-a": { busy: [] } },
        });
      }
      return jsonResponse({
        id: "a12345",
        htmlLink: "https://calendar.google.com/event/123",
      });
    },
  });

  const availability = await client.getAvailability({
    accessToken: "access-token",
    calendarId: "calendar-a",
    startTimeUtc: "2026-08-17T18:00:00.000Z",
    endTimeUtc: "2026-08-17T18:30:00.000Z",
    timezone: "America/New_York",
  });
  const booking = await client.createBooking({
    accessToken: "access-token",
    calendarId: "calendar-a",
    providerId: "a12345",
    startTimeUtc: "2026-08-17T18:00:00.000Z",
    endTimeUtc: "2026-08-17T18:30:00.000Z",
    timezone: "America/New_York",
    service: "Consultation",
    customer: { email: "jordan@example.com" },
    callId,
    idempotencyKey: "booking-1",
  });

  assert.equal(availability.available, true);
  assert.equal(booking.providerEventId, "a12345");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    timeMin: "2026-08-17T18:00:00.000Z",
    timeMax: "2026-08-17T18:30:00.000Z",
    timeZone: "America/New_York",
    items: [{ id: "calendar-a" }],
  });
  assert.equal(JSON.parse(requests[1].options.body).id, "a12345");
});

test("Microsoft adapter sends UTC event times and transaction id", async () => {
  let request;
  const client = createMicrosoftCalendarClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        id: "graph-event-1",
        webLink: "https://outlook.office.com/event/1",
      });
    },
  });

  const booking = await client.createBooking({
    accessToken: "access-token",
    calendarId: "calendar-a",
    providerId: "11111111-1111-4111-a111-111111111111",
    startTimeUtc: "2026-08-17T18:00:00.000Z",
    endTimeUtc: "2026-08-17T18:30:00.000Z",
    timezone: "America/New_York",
    service: "Consultation",
  });

  const body = JSON.parse(request.options.body);
  assert.equal(booking.providerEventId, "graph-event-1");
  assert.deepEqual(body.start, {
    dateTime: "2026-08-17T18:00:00.000",
    timeZone: "UTC",
  });
  assert.equal(body.transactionId, "11111111-1111-4111-a111-111111111111");
});

test("provider idempotency ids satisfy Google and Microsoft formats", () => {
  const ids = providerIdempotencyIds(workspaceId, "booking-key");

  assert.match(ids.googleEventId, /^[a-v0-9]{5,1024}$/);
  assert.match(
    ids.microsoftTransactionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

function toolHandler({
  store = createStore(),
  calendar = {
    async getAvailability() {
      return { available: true, busy: [] };
    },
    async createBooking() {
      return {
        providerEventId: "event-1",
        provider: "google-calendar",
      };
    },
  },
  now = () => new Date("2026-08-16T12:00:00.000Z"),
} = {}) {
  return createHandler({
    verifySignature: async (_rawBody, apiKey, value) =>
      apiKey === "retell-key" && value === signature,
    getRetellApiKey: async () => "retell-key",
    getStore: async () => store,
    getCalendar: async () => calendar,
    now,
  });
}

function createStore(overrides = {}) {
  return {
    async getBusinessProfile() {
      return { timezone: "America/New_York" };
    },
    async getAppointment() {
      return null;
    },
    async putAppointment(record) {
      return clone(record);
    },
    async updateAppointment(_workspaceId, _appointmentId, updates) {
      return clone(updates);
    },
    async getLead() {
      return null;
    },
    async putLead(record) {
      return clone(record);
    },
    async getMessage() {
      return null;
    },
    async putMessage(record) {
      return clone(record);
    },
    async getAgent() {
      return null;
    },
    ...overrides,
  };
}

function putOnce(records, id, record) {
  if (records.has(id)) {
    const error = new Error("exists");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }
  records.set(id, clone(record));
  return clone(record);
}

function bookingBody(overrides = {}) {
  return requiredBody({
    agentId: "agent-1",
    startTime: "2026-08-17T14:00:00-04:00",
    endTime: "2026-08-17T14:30:00-04:00",
    service: "Consultation",
    customer: {
      name: "Jordan Miles",
      phone: "+17035550123",
      email: "jordan@example.com",
    },
    ...overrides,
  });
}

function requiredBody(overrides = {}) {
  return {
    workspaceId,
    callId,
    idempotencyKey: "idempotency-key",
    ...overrides,
  };
}

function event(path, body, signatureValue = signature) {
  return {
    requestContext: { http: { method: "POST", path } },
    rawPath: path,
    headers: { "x-retell-signature": signatureValue },
    body: JSON.stringify(body),
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
