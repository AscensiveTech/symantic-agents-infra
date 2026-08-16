import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createHandler } from "../../lambda/tools/index.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/retell-tools.json", import.meta.url),
  "utf8",
));

test("Retell tool request and response fixtures match every HTTP route", async () => {
  const records = new Map([[
    "apt-existing",
    {
      workspaceId: "workspace-123",
      appointmentId: "apt-existing",
      provider: "google-calendar",
      providerEventId: "provider-event-existing",
      status: "confirmed",
      startTimeUtc: "2026-08-17T18:00:00.000Z",
      endTimeUtc: "2026-08-17T18:30:00.000Z",
      timezone: "America/New_York",
    },
  ]]);
  const store = {
    async getBusinessProfile() {
      return {
        timezone: "America/New_York",
        escalationContact: "+17035550199",
        ownerPhone: "+17035550100",
        fallbackPhone: "+17035550188",
      };
    },
    async getAppointment(_workspaceId, appointmentId) {
      return records.get(appointmentId) ?? null;
    },
    async putAppointment(record) {
      records.set(record.appointmentId, record);
      return record;
    },
    async updateAppointment(_workspaceId, appointmentId, updates) {
      const record = { ...records.get(appointmentId), ...updates };
      records.set(appointmentId, record);
      return record;
    },
    async getLead() {
      return null;
    },
    async putLead(record) {
      return record;
    },
    async getMessage() {
      return null;
    },
    async putMessage(record) {
      return record;
    },
    async getAgent() {
      return {
        configuration: {
          escalation: "Transfer emergencies to +17035550177.",
        },
      };
    },
  };
  const calendar = {
    async getAvailability() {
      return { available: true, busy: [] };
    },
    async createBooking() {
      return {
        provider: "google-calendar",
        providerEventId: "provider-event-new",
      };
    },
    async rescheduleBooking() {
      return {
        provider: "google-calendar",
        providerEventId: "provider-event-existing",
      };
    },
    async cancelBooking() {
      return {
        provider: "google-calendar",
        providerEventId: "provider-event-existing",
      };
    },
  };
  const handler = createHandler({
    verifySignature: async () => true,
    getRetellApiKey: async () => "test-key",
    getStore: async () => store,
    getCalendar: async () => calendar,
    now: () => new Date("2026-08-16T12:00:00.000Z"),
  });

  for (const [toolName, fixture] of Object.entries(fixtures)) {
    const response = await handler({
      requestContext: { http: { method: "POST", path: fixture.path } },
      rawPath: fixture.path,
      headers: { "x-retell-signature": "fixture-signature" },
      body: JSON.stringify(fixture.request),
    });
    assert.equal(response.statusCode, 200, `${toolName} fixture must return 200`);
    const body = JSON.parse(response.body);
    for (const key of fixture.responseKeys) {
      assert.ok(
        Object.hasOwn(body, key),
        `${toolName} fixture response must include ${key}`,
      );
    }
  }
});

test("Retell tool fixtures carry the required request identity fields", () => {
  for (const [toolName, fixture] of Object.entries(fixtures)) {
    assert.equal(typeof fixture.request.workspaceId, "string", `${toolName} workspaceId`);
    assert.equal(typeof fixture.request.callId, "string", `${toolName} callId`);
    assert.equal(
      typeof fixture.request.idempotencyKey,
      "string",
      `${toolName} idempotencyKey`,
    );
  }
});
