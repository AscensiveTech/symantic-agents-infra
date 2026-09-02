import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

async function loadBff() {
  try {
    return await import("./index.mjs");
  } catch (error) {
    assert.fail(`BFF handler module must load: ${error.message}`);
  }
}

test("PUT profile rejects unauthenticated", async () => {
  const { handler } = await loadBff();
  const response = await handler({
    requestContext: {
      http: {
        method: "PUT",
        path: "/workspaces/me/profile",
      },
    },
    rawPath: "/workspaces/me/profile",
    body: JSON.stringify({ businessName: "Arc Dental" }),
  });

  assert.equal(response.statusCode, 401);
});

test("PUT profile stores the authenticated workspace profile", async () => {
  const profile = {
    businessType: "dental",
    businessName: "Arc Dental",
    address: "123 Main Street",
    timezone: "America/New_York",
    phone: "(703) 555-0133",
    description: "Family dental care",
    hours: "Mon-Fri, 8:00 AM-5:00 PM",
    faqs: [{ question: "Do you accept insurance?", answer: "Yes." }],
    policies: "Call before cancelling.",
    escalationContact: "(703) 555-0199",
    ownerPhone: "(703) 555-0100",
    fallbackPhone: "(703) 555-0199",
    communicationStyle: "Warm, concise, and professional",
  };
  const calls = [];
  const store = {
    async ensureWorkspace(workspaceId) {
      calls.push(["ensureWorkspace", workspaceId]);
    },
    async putProfile(workspaceId, value) {
      calls.push(["putProfile", workspaceId, value]);
      return value;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler({
    requestContext: {
      authorizer: { jwt: { claims: { sub: "user-123" } } },
      http: {
        method: "PUT",
        path: "/workspaces/me/profile",
      },
    },
    rawPath: "/workspaces/me/profile",
    body: JSON.stringify(profile),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), profile);
  assert.deepEqual(calls, [
    ["ensureWorkspace", "user-123"],
    ["putProfile", "user-123", profile],
  ]);
});

test("GET profile ensures the workspace and returns its profile", async () => {
  const calls = [];
  const profile = { businessName: "Arc Dental" };
  const store = {
    async ensureWorkspace(workspaceId) {
      calls.push(["ensureWorkspace", workspaceId]);
    },
    async getProfile(workspaceId) {
      calls.push(["getProfile", workspaceId]);
      return profile;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent("GET", "/workspaces/me/profile"));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), profile);
  assert.deepEqual(calls, [
    ["ensureWorkspace", "user-123"],
    ["getProfile", "user-123"],
  ]);
});

test("PUT profile rejects an invalid body before accessing DynamoDB", async () => {
  const getStore = () => {
    throw new Error("store should not be loaded");
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore });

  const response = await handler(authenticatedEvent(
    "PUT",
    "/workspaces/me/profile",
    { businessName: "Incomplete" },
  ));

  assert.equal(response.statusCode, 400);
});

test("PUT profile round-trips valid structured business hours and rejects malformed ones", async () => {
  const base = {
    businessType: "dental",
    businessName: "Arc Dental",
    address: "123 Main Street",
    timezone: "America/New_York",
    phone: "(703) 555-0133",
    description: "Family dental care",
    hours: "Mon–Fri 8:00 AM–5:00 PM, Sat–Sun closed",
    faqs: [{ question: "Do you accept insurance?", answer: "Yes." }],
    policies: "Call before cancelling.",
    escalationContact: "(703) 555-0199",
    ownerPhone: "(703) 555-0100",
    fallbackPhone: "(703) 555-0199",
    communicationStyle: "Warm, concise, and professional",
  };
  const businessHours = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((key) => [
      key,
      {
        closed: key === "sat" || key === "sun",
        intervals: [{ open: "08:00", close: "17:00" }],
      },
    ]),
  );

  const stored = [];
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => ({
      async ensureWorkspace() {},
      async putProfile(_workspaceId, value) {
        stored.push(value);
        return value;
      },
    }),
  });

  const ok = await handler(authenticatedEvent("PUT", "/workspaces/me/profile", {
    ...base,
    businessHours,
  }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(stored[0].businessHours, businessHours);

  const bad = await handler(authenticatedEvent("PUT", "/workspaces/me/profile", {
    ...base,
    businessHours: { mon: { closed: false, intervals: [{ open: "8am", close: "5pm" }] } },
  }));
  assert.equal(bad.statusCode, 400);
  assert.equal(stored.length, 1);
});

test("POST and GET agents preserve product agent ids", async () => {
  const agents = new Map();
  const store = {
    async ensureWorkspace() {},
    async createAgent(workspaceId, agentId, agent) {
      agents.set(`${workspaceId}:${agentId}`, agent);
      return agent;
    },
    async listAgents(workspaceId) {
      return [...agents.entries()]
        .filter(([key]) => key.startsWith(`${workspaceId}:`))
        .map(([, agent]) => agent);
    },
  };
  const agent = {
    id: "agent-123",
    name: "Maya",
    role: "Phone operations",
    description: "Answers calls",
    status: "active",
    capabilities: ["Inbound calls"],
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const created = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents",
    agent,
  ));
  const listed = await handler(authenticatedEvent("GET", "/workspaces/me/agents"));

  assert.equal(created.statusCode, 201);
  const savedAgent = { ...agent, status: "draft" };
  assert.deepEqual(JSON.parse(created.body), savedAgent);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(JSON.parse(listed.body), [savedAgent]);
});

test("POST agent returns 409 when the agent already exists", async () => {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  const store = {
    async ensureWorkspace() {},
    async createAgent() {
      throw error;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents",
    {
      id: "agent-123",
      name: "Maya",
      role: "Phone operations",
      description: "Answers calls",
      status: "active",
      capabilities: ["Inbound calls"],
    },
  ));

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).message, "Agent already exists");
});

test("GET agent returns 404 when the workspace agent is missing", async () => {
  const store = {
    async ensureWorkspace() {},
    async getAgent() {
      return null;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "GET",
    "/workspaces/me/agents/agent-404",
  ));

  assert.equal(response.statusCode, 404);
});

test("PUT agent returns 404 when the agent is missing", async () => {
  const error = new Error("The conditional request failed");
  error.name = "ConditionalCheckFailedException";
  const store = {
    async ensureWorkspace() {},
    async putAgent() {
      throw error;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "PUT",
    "/workspaces/me/agents/agent-404",
    {
      id: "agent-404",
      name: "Maya",
      role: "Phone operations",
      description: "Answers calls",
      status: "draft",
      capabilities: ["Inbound calls"],
    },
  ));

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).message, "Agent not found");
});

test("PUT agent uses the route id and returns the updated agent", async () => {
  const calls = [];
  const store = {
    async ensureWorkspace() {},
    async putAgent(workspaceId, agentId, agent) {
      calls.push([workspaceId, agentId, agent]);
      return agent;
    },
  };
  const agent = {
    id: "agent-123",
    name: "Maya Updated",
    role: "Phone operations",
    description: "Answers and books",
    status: "active",
    capabilities: ["Inbound calls", "Calendar"],
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "PUT",
    "/workspaces/me/agents/agent-123",
    agent,
  ));

  assert.equal(response.statusCode, 200);
  const savedAgent = { ...agent, status: "draft" };
  assert.deepEqual(JSON.parse(response.body), savedAgent);
  assert.deepEqual(calls, [["user-123", "agent-123", savedAgent]]);
});

test("PUT agent invalidates a successful test when launch configuration changes", async () => {
  let saved;
  const existing = receptionistAgent();
  const changed = {
    ...existing,
    configuration: {
      ...existing.configuration,
      guidance: "Updated answering restrictions.",
      tested: false,
    },
  };
  const store = {
    async ensureWorkspace() {},
    async getAgent() {
      return existing;
    },
    async putAgent(_workspaceId, _agentId, agent, options) {
      saved = { agent, options };
      return agent;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "PUT",
    "/workspaces/me/agents/agent-123",
    changed,
  ));

  assert.equal(response.statusCode, 200);
  assert.equal(saved.options.invalidateTest, true);
  assert.equal(saved.agent.status, "draft");
});

test("GET calls lists workspace calls without exposing Retell identifiers", async () => {
  const calls = [{
    workspaceId: "user-123",
    callId: "call-123",
    retellCallId: "retell-call-secret",
    callerNumber: "+17035550123",
    outcome: "answered",
    startedAt: "2026-08-16T14:00:00.000Z",
    callSummary: "Caller asked about hours.",
    recordingKey: "calls/call-123.wav",
    transcript: [{ speaker: "Caller", text: "Hello" }],
    toolLog: [{ role: "tool_call_result", tool_call_id: "retell-tool-1" }],
  }];
  const store = {
    async ensureWorkspace() {},
    async listCalls(workspaceId) {
      assert.equal(workspaceId, "user-123");
      return calls;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "GET",
    "/workspaces/me/calls",
  ));

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body, [{
    callId: "call-123",
    callerNumber: "+17035550123",
    outcome: "answered",
    startedAt: "2026-08-16T14:00:00.000Z",
    callSummary: "Caller asked about hours.",
    hasRecording: true,
  }]);
  assert.doesNotMatch(response.body, /retell-call-secret/);
  assert.doesNotMatch(response.body, /calls\/call-123\.wav/); // recordingKey is not exposed
});

test("GET call detail uses the product call id and hides provider keys", async () => {
  let requested;
  const store = {
    async ensureWorkspace() {},
    async getCall(workspaceId, callId) {
      requested = { workspaceId, callId };
      return {
        workspaceId,
        callId,
        retellCallId: "retell-call-secret",
        transcript: [{ speaker: "Caller", text: "Hello" }],
        recordingKey: "calls/call-123.wav",
        callSummary: "Caller asked about hours.",
        outcome: "answered",
      };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const response = await handler(authenticatedEvent(
    "GET",
    "/workspaces/me/calls/call-123",
  ));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requested, {
    workspaceId: "user-123",
    callId: "call-123",
  });
  assert.deepEqual(JSON.parse(response.body), {
    callId: "call-123",
    transcript: [{ speaker: "Caller", text: "Hello" }],
    callSummary: "Caller asked about hours.",
    hasRecording: true,
    outcome: "answered",
  });
  assert.doesNotMatch(response.body, /retell-call-secret/);
  assert.doesNotMatch(response.body, /calls\/call-123\.wav/);
});

test("GET call recording returns a presigned URL, or 404 when there is none", async () => {
  const store = {
    async ensureWorkspace() {},
    async getCall(workspaceId, callId) {
      if (callId === "call-nokey") return { workspaceId, callId };
      return { workspaceId, callId, recordingKey: "calls/call-123.wav" };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getRecordingSigner: async () => ({
      async createDownloadUrl(workspaceId, key) {
        assert.equal(workspaceId, "user-123");
        assert.equal(key, "calls/call-123.wav");
        return "https://call-artifacts.s3.amazonaws.com/workspaces/user-123/calls/call-123.wav?sig=abc";
      },
    }),
  });

  const ok = await handler(authenticatedEvent("GET", "/workspaces/me/calls/call-123/recording"));
  assert.equal(ok.statusCode, 200);
  assert.match(JSON.parse(ok.body).url, /call-artifacts\.s3\.amazonaws\.com/);

  const missing = await handler(authenticatedEvent("GET", "/workspaces/me/calls/call-nokey/recording"));
  assert.equal(missing.statusCode, 404);
});

test("Dynamo agent updates preserve provider foreign keys", async () => {
  class UpdateItemCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class PutItemCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const commands = {
    UpdateItemCommand,
    PutItemCommand,
  };
  let sent;
  const client = {
    async send(command) {
      sent = command;
      return {};
    },
  };
  const { createDynamoStore } = await loadBff();
  const store = createDynamoStore(client, commands, {
    agents: "agents-table",
  });
  const agent = receptionistAgent();

  await store.putAgent("workspace-123", "agent-123", agent);

  assert.ok(sent instanceof UpdateItemCommand);
  assert.equal(sent.input.TableName, "agents-table");
  assert.equal(sent.input.ConditionExpression, "attribute_exists(agentId)");
  assert.ok(!Object.values(sent.input.ExpressionAttributeNames).includes(
    "retellAgentId",
  ));
});

test("POST activate provisions the DID before syncing Retell and keeps Symantic route ids", async () => {
  const events = [];
  const agent = receptionistAgent();
  const profile = receptionistProfile();
  const store = {
    async ensureWorkspace() {},
    async getAgent(workspaceId, agentId) {
      events.push(["getAgent", workspaceId, agentId]);
      return agent;
    },
    async getProfile(workspaceId) {
      events.push(["getProfile", workspaceId]);
      return profile;
    },
    async getCalendarConnection() {
      return {
        provider: "google-calendar",
        selectedCalendarId: "primary",
        connectionState: "connected",
      };
    },
    async getPhoneNumberForAgent() {
      return null;
    },
    async putPhoneNumber(record) {
      events.push(["putPhoneNumber", record]);
      return record;
    },
    async updateAgentRuntime(workspaceId, agentId, updates) {
      events.push(["updateAgentRuntime", workspaceId, agentId, updates]);
      return { ...agent, ...updates };
    },
  };
  const providers = {
    telnyx: {
      async ensureNumber(input) {
        events.push(["telnyx", input]);
        return {
          telnyxNumberId: "telnyx-number-123",
          telnyxPhoneNumber: "+17035550177",
          telnyxOrderId: "telnyx-order-123",
        };
      },
    },
    retell: {
      async upsertAgent(input) {
        events.push(["retell", input]);
        return { retellAgentId: "retell-agent-123" };
      },
      async importPhoneNumber(input) {
        events.push(["importPhoneNumber", input]);
        return { retellPhoneNumberId: input.phoneNumber };
      },
    },
    resolveVoiceId(requestedVoice) {
      events.push(["voice", requestedVoice]);
      return "retell-Cimo";
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getProviders: async () => providers,
    toolBaseUrl: "https://api.example.com",
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/activate",
  ));

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.agent.id, "agent-123");
  assert.equal(body.agent.status, "active");
  assert.equal(body.agent.retellAgentId, undefined);
  assert.equal(body.phoneNumber.id, "phone-agent-123");
  assert.equal(body.phoneNumber.phoneNumber, "+17035550177");
  assert.equal(body.phoneNumber.telnyxNumberId, undefined);
  assert.ok(
    events.findIndex(([name]) => name === "retell") <
      events.findIndex(([name]) => name === "importPhoneNumber") &&
      events.findIndex(([name]) => name === "importPhoneNumber") <
        events.findIndex(([name]) => name === "putPhoneNumber"),
  );
  const retellInput = events.find(([name]) => name === "retell")[1];
  assert.equal(retellInput.symanticAgentId, "agent-123");
  assert.match(retellInput.config.prompt, /Mon-Fri, 8:00 AM-5:00 PM/);
  assert.ok(retellInput.config.tools.filter(({ type }) => type === "custom").every(({ url }) =>
    url.startsWith("https://api.example.com/retell/tools/")
  ));
  const importInput = events.find(([name]) => name === "importPhoneNumber")[1];
  assert.equal(importInput.phoneNumber, "+17035550177");
  assert.equal(importInput.retellAgentId, "retell-agent-123");
  assert.equal(
    importInput.inboundWebhookUrl,
    "https://api.example.com/retell/inbound-lookup",
  );
  const persistedPhone = events.find(([name]) => name === "putPhoneNumber")[1];
  assert.equal(persistedPhone.phoneNumberId, "phone-agent-123");
  assert.equal(persistedPhone.retellPhoneNumberId, "+17035550177");
});

test("POST activate rejects an untested current configuration", async () => {
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => ({
      async ensureWorkspace() {},
      async getAgent() {
        const agent = receptionistAgent();
        delete agent.tested;
        delete agent.testedAt;
        return agent;
      },
      async getProfile() {
        return receptionistProfile();
      },
      async getCalendarConnection() {
        return {
          provider: "google-calendar",
          selectedCalendarId: "primary",
          connectionState: "connected",
        };
      },
    }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/activate",
  ));

  assert.equal(response.statusCode, 409);
  assert.match(JSON.parse(response.body).message, /successful current-config test/i);
});

test("POST activate rejects booking without a connected selected calendar", async () => {
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => ({
      async ensureWorkspace() {},
      async getAgent() {
        return receptionistAgent();
      },
      async getProfile() {
        return receptionistProfile();
      },
      async getCalendarConnection() {
        return {
          provider: "google-calendar",
          selectedCalendarId: null,
          connectionState: "connected",
        };
      },
    }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/activate",
  ));

  assert.equal(response.statusCode, 409);
  assert.match(JSON.parse(response.body).message, /select a booking calendar/i);
});

test("POST activate persists retellAgentId before the rest of the runtime update", async () => {
  const runtimeUpdates = [];
  const agent = receptionistAgent();
  const store = {
    async ensureWorkspace() {},
    async getAgent() {
      return agent;
    },
    async getProfile() {
      return receptionistProfile();
    },
    async getCalendarConnection() {
      return {
        provider: "google-calendar",
        selectedCalendarId: "primary",
        connectionState: "connected",
      };
    },
    async getPhoneNumberForAgent() {
      return {
        workspaceId: "user-123",
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxNumberId: "telnyx-number-123",
        telnyxPhoneNumber: "+17035550177",
        retellPhoneNumberId: "+17035550177",
      };
    },
    async updateAgentRuntime(_workspaceId, _agentId, updates) {
      runtimeUpdates.push(updates);
      if (runtimeUpdates.length === 1) {
        return { ...agent, ...updates };
      }
      throw new Error("status update failed");
    },
    async putPhoneNumber(record) {
      return record;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getProviders: async () => ({
      telnyx: {
        async ensureNumber() {
          assert.fail("existing DID must be reused");
        },
      },
      retell: {
        async upsertAgent() {
          return { retellAgentId: "retell-agent-123" };
        },
      },
      resolveVoiceId: () => "retell-Cimo",
    }),
    toolBaseUrl: "https://api.example.com",
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/activate",
  ));

  assert.equal(response.statusCode, 500);
  assert.deepEqual(runtimeUpdates[0], { retellAgentId: "retell-agent-123" });
  assert.equal(runtimeUpdates.length, 2);
});

test("POST activate reuses the linked DID and upserts the existing Retell agent", async () => {
  const agent = {
    ...receptionistAgent(),
    retellAgentId: "retell-agent-existing",
  };
  let telnyxCalls = 0;
  let retellInput;
  const store = {
    async ensureWorkspace() {},
    async getAgent() {
      return agent;
    },
    async getProfile() {
      return receptionistProfile();
    },
    async getCalendarConnection() {
      return {
        provider: "google-calendar",
        selectedCalendarId: "primary",
        connectionState: "connected",
      };
    },
    async getPhoneNumberForAgent() {
      return {
        workspaceId: "user-123",
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxNumberId: "telnyx-number-existing",
        telnyxPhoneNumber: "+17035550166",
        retellPhoneNumberId: "+17035550166",
      };
    },
    async updateAgentRuntime(_workspaceId, _agentId, updates) {
      return { ...agent, ...updates };
    },
    async putPhoneNumber(record) {
      return record;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getProviders: async () => ({
      telnyx: {
        async ensureNumber() {
          telnyxCalls += 1;
        },
      },
      retell: {
        async upsertAgent(input) {
          retellInput = input;
          return { retellAgentId: "retell-agent-existing" };
        },
      },
      resolveVoiceId: () => "retell-Cimo",
    }),
    toolBaseUrl: "https://api.example.com",
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/activate",
  ));

  assert.equal(response.statusCode, 200);
  assert.equal(telnyxCalls, 0);
  assert.equal(retellInput.retellAgentId, "retell-agent-existing");
});

test("POST start-test-call creates a Retell phone call without marking the draft tested", async () => {
  const agent = {
    ...receptionistAgent(),
    retellAgentId: "retell-agent-123",
  };
  const store = {
    async ensureWorkspace() {},
    async getAgent() {
      return agent;
    },
    async getProfile() {
      return receptionistProfile();
    },
    async getPhoneNumberForAgent() {
      return {
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxPhoneNumber: "+17035550177",
        retellPhoneNumberId: "+17035550177",
        status: "draft",
      };
    },
    async updateAgentRuntime(_workspaceId, _agentId, updates) {
      assert.deepEqual(updates, { retellAgentId: "retell-agent-123" });
      return { ...agent, ...updates };
    },
    async putPhoneNumber() {
      return undefined;
    },
  };
  let phoneCallInput;
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getProviders: async () => ({
      retell: {
        async upsertAgent() {
          return { retellAgentId: "retell-agent-123" };
        },
        async startPhoneCall(input) {
          phoneCallInput = input;
          return { callId: "call-123", status: "registered" };
        },
      },
      telnyx: {
        async ensureNumber() {
          assert.fail("existing DID must be reused");
        },
      },
      resolveVoiceId: () => "retell-Cimo",
    }),
    toolBaseUrl: "https://api.example.com",
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/agents/agent-123/start-test-call",
    { toNumber: "+17035550100" },
  ));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), {
    callId: "call-123",
    status: "registered",
    phoneNumber: {
      id: "phone-agent-123",
      agentId: "agent-123",
      phoneNumber: "+17035550177",
      status: "draft",
    },
  });
  const { currentTime, ...restCallInput } = phoneCallInput;
  assert.equal(typeof currentTime, "string");
  assert.ok(currentTime.length > 0);
  assert.deepEqual(restCallInput, {
    fromNumber: "+17035550177",
    toNumber: "+17035550100",
    retellAgentId: "retell-agent-123",
    workspaceId: "user-123",
    agentId: "agent-123",
    timezone: "America/New_York",
  });
  assert.equal(agent.configuration.tested, false);
  assert.equal(agent.configuration.testedAt, undefined);
});

test("POST inbound lookup uses Retell's call_inbound request and response contract", async () => {
  const rawBody = JSON.stringify({
    event: "call_inbound",
    call_inbound: {
      agent_id: "retell-default",
      agent_version: 1,
      from_number: "+17035550100",
      to_number: "+17035550177",
    },
  });
  const calls = [];
  const store = {
    async getPhoneNumberByDid(did) {
      calls.push(["getPhoneNumberByDid", did]);
      return {
        workspaceId: "workspace-123",
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxPhoneNumber: did,
      };
    },
    async getAgent(workspaceId, agentId) {
      calls.push(["getAgent", workspaceId, agentId]);
      return {
        ...receptionistAgent(),
        status: "active",
        retellAgentId: "retell-agent-123",
      };
    },
    async getProfile(workspaceId) {
      calls.push(["getProfile", workspaceId]);
      return receptionistProfile();
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getRetellApiKey: async () => "retell-key",
    verifySignature(body, apiKey, signature) {
      calls.push(["verify", body, apiKey, signature]);
      return true;
    },
    getProviders: async () => ({
      resolveVoiceId: () => "retell-Cimo",
    }),
    toolBaseUrl: "https://api.example.com",
  });

  const response = await handler({
    requestContext: {
      http: {
        method: "POST",
        path: "/retell/inbound-lookup",
      },
    },
    rawPath: "/retell/inbound-lookup",
    headers: { "X-Retell-Signature": "signature-123" },
    body: rawBody,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0], [
    "verify",
    rawBody,
    "retell-key",
    "signature-123",
  ]);
  const body = JSON.parse(response.body);
  const { currentTime, ...restVars } = body.call_inbound.dynamic_variables;
  assert.equal(typeof currentTime, "string");
  assert.ok(currentTime.length > 0);
  assert.deepEqual(restVars, {
    workspaceId: "workspace-123",
    agentId: "agent-123",
    timezone: "America/New_York",
  });
  assert.deepEqual(body.call_inbound.override_agent_id, "retell-agent-123");
  assert.deepEqual(body.call_inbound.metadata, {
    workspaceId: "workspace-123",
    agentId: "agent-123",
  });
});

test("POST inbound lookup rejects calls for a draft agent", async () => {
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getRetellApiKey: async () => "retell-key",
    verifySignature: () => true,
    getStore: async () => ({
      async getPhoneNumberByDid() {
        return {
          workspaceId: "workspace-123",
          agentId: "agent-123",
        };
      },
      async getAgent() {
        return receptionistAgent();
      },
      async getProfile() {
        return receptionistProfile();
      },
    }),
  });

  const response = await handler({
    requestContext: {
      http: { method: "POST", path: "/retell/inbound-lookup" },
    },
    rawPath: "/retell/inbound-lookup",
    headers: { "x-retell-signature": "valid" },
    body: JSON.stringify({
      event: "call_inbound",
      call_inbound: {
        from_number: "+17035550100",
        to_number: "+17035550177",
      },
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    call_inbound: { reject: true },
  });
});

test("POST inbound lookup rejects an invalid signature before DynamoDB", async () => {
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => {
      assert.fail("invalid signatures must not access DynamoDB");
    },
    getRetellApiKey: async () => "retell-key",
    verifySignature: () => false,
  });

  const response = await handler({
    requestContext: {
      http: {
        method: "POST",
        path: "/retell/inbound-lookup",
      },
    },
    rawPath: "/retell/inbound-lookup",
    headers: { "x-retell-signature": "invalid" },
    body: JSON.stringify({
      event: "call_inbound",
      call_inbound: {
        from_number: "+17035550100",
        to_number: "+17035550177",
      },
    }),
  });

  assert.equal(response.statusCode, 401);
});

test("proposal routes persist, update, duplicate, and isolate workspace records", async () => {
  const records = new Map();
  const key = (workspaceId, proposalId) => `${workspaceId}:${proposalId}`;
  const store = {
    async ensureWorkspace() {},
    async listProposals(workspaceId) {
      return [...records.entries()]
        .filter(([recordKey]) => recordKey.startsWith(`${workspaceId}:`))
        .map(([, value]) => value);
    },
    async createProposal(workspaceId, proposal) {
      records.set(key(workspaceId, proposal.id), structuredClone(proposal));
      return proposal;
    },
    async getProposal(workspaceId, proposalId) {
      return records.get(key(workspaceId, proposalId)) ?? null;
    },
    async putProposal(workspaceId, proposal) {
      records.set(key(workspaceId, proposal.id), structuredClone(proposal));
      return proposal;
    },
    async deleteProposal(workspaceId, proposalId) {
      records.delete(key(workspaceId, proposalId));
    },
  };
  const proposal = {
    id: "prp-123",
    name: "Dental modernization",
    status: "draft",
    documentItems: [],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const created = await handler(authenticatedEvent("POST", "/workspaces/me/proposals", proposal));
  const listed = await handler(authenticatedEvent("GET", "/workspaces/me/proposals"));
  const updated = await handler(authenticatedEvent(
    "PATCH",
    "/workspaces/me/proposals/prp-123",
    { ...proposal, name: "Updated proposal" },
  ));
  const duplicated = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-123/duplicate",
  ));
  const removed = await handler(authenticatedEvent("DELETE", "/workspaces/me/proposals/prp-123"));

  assert.equal(created.statusCode, 201);
  assert.deepEqual(JSON.parse(listed.body), [proposal]);
  assert.equal(JSON.parse(updated.body).name, "Updated proposal");
  const copy = JSON.parse(duplicated.body);
  assert.equal(duplicated.statusCode, 201);
  assert.match(copy.id, /^prp-/);
  assert.equal(copy.name, "Updated proposal copy");
  assert.equal(removed.statusCode, 200);
  assert.equal(records.has(key("user-123", "prp-123")), false);
  assert.equal([...records.keys()].every((recordKey) => recordKey.startsWith("user-123:")), true);
});

test("proposal template and part routes match the frontend API contract", async () => {
  const templates = new Map();
  const parts = new Map();
  const store = {
    async ensureWorkspace() {},
    async listProposalTemplates() { return [...templates.values()]; },
    async createProposalTemplate(_workspaceId, template) {
      templates.set(template.id, template);
      return template;
    },
    async getProposalTemplate(_workspaceId, templateId) { return templates.get(templateId) ?? null; },
    async putProposalTemplate(_workspaceId, template) {
      templates.set(template.id, template);
      return template;
    },
    async deleteProposalTemplate(_workspaceId, templateId) { templates.delete(templateId); },
    async listParts() { return [...parts.values()]; },
    async createPart(_workspaceId, part) { parts.set(part.id, part); return part; },
    async putPart(_workspaceId, part) { parts.set(part.id, part); return part; },
    async putParts(_workspaceId, values) {
      values.forEach((part) => parts.set(part.id, part));
      return values;
    },
    async deletePart(_workspaceId, partId) { parts.delete(partId); },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const template = { id: "tpl-123", name: "Default", isDefault: true, items: [] };
  const part = { id: "part-123", name: "Display", msrpPrice: 1000 };

  assert.equal((await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposal-templates",
    template,
  ))).statusCode, 201);
  assert.equal((await handler(authenticatedEvent(
    "PATCH",
    "/workspaces/me/proposal-templates/tpl-123",
    { ...template, name: "Updated" },
  ))).statusCode, 200);
  assert.equal((await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/parts",
    part,
  ))).statusCode, 201);
  const bulk = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/parts/bulk",
    { parts: [{ ...part, msrpPrice: 1200 }, { id: "part-456", name: "Mount" }] },
  ));

  assert.equal(bulk.statusCode, 200);
  assert.equal(parts.size, 2);
  assert.equal(parts.get("part-123").msrpPrice, 1200);
  assert.equal(JSON.parse((await handler(authenticatedEvent(
    "GET",
    "/workspaces/me/proposal-templates/tpl-123",
  ))).body).name, "Updated");
});

test("proposal asset routes issue workspace-scoped PDF URLs and reject traversal", async () => {
  const calls = [];
  const signer = {
    async createUploadUrl(...args) { calls.push(["upload", ...args]); return "https://upload.example.com"; },
    async createDownloadUrl(...args) { calls.push(["download", ...args]); return "https://download.example.com"; },
  };
  const store = { async ensureWorkspace() {} };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getAssetSigner: async () => signer,
  });

  const uploaded = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposal-assets/upload-url",
    { key: "proposals/prp-123/cover.pdf", contentType: "application/pdf" },
  ));
  const downloaded = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposal-assets/download-url",
    { key: "proposals/prp-123/cover.pdf" },
  ));
  const invalid = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposal-assets/download-url",
    { key: "../another-workspace/private.pdf" },
  ));

  assert.equal(uploaded.statusCode, 200);
  assert.equal(downloaded.statusCode, 200);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(calls, [
    ["upload", "user-123", "proposals/prp-123/cover.pdf", "application/pdf"],
    ["download", "user-123", "proposals/prp-123/cover.pdf"],
  ]);
});

test("proposal signature requests send the private PDF through SignWell and persist safe status", async () => {
  const proposals = new Map();
  const proposal = {
    id: "prp-sign",
    name: "Dental modernization",
    signerNames: ["Jane Client"],
    documentItems: [{ id: "agreement", kind: "agreement", hidden: false }],
  };
  proposals.set("user-123:prp-sign", proposal);
  let signWellRequest;
  const store = {
    async ensureWorkspace() {},
    async getProposal(workspaceId, proposalId) {
      return proposals.get(`${workspaceId}:${proposalId}`) ?? null;
    },
    async updateProposalSignature(workspaceId, proposalId, signatureRequest) {
      const current = proposals.get(`${workspaceId}:${proposalId}`);
      proposals.set(`${workspaceId}:${proposalId}`, { ...current, signatureRequest });
      return signatureRequest;
    },
  };
  const signWell = {
    webhookId: "webhook-123",
    client: {
      testMode: true,
      async createDocument(input) {
        signWellRequest = input;
        return {
          id: "signwell-doc-123",
          status: "Created",
          test_mode: true,
          recipients: [{
            id: "1",
            status: "sent",
            embedded_signing_url: "https://www.signwell.com/docs/test-signing/",
          }],
        };
      },
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => signWell,
    getAssetSigner: async () => ({
      async createDownloadUrl(workspaceId, key) {
        assert.equal(workspaceId, "user-123");
        assert.equal(key, "exports/prp-sign.pdf");
        return "https://private-pdf.example.com/short-lived";
      },
    }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-sign/signature-requests",
    {
      assetKey: "exports/prp-sign.pdf",
      recipients: [{ name: "Jane Client", email: "JANE@example.com" }],
      subject: "Please sign Dental modernization",
      message: "Please review and sign this proposal.",
      applySigningOrder: false,
    },
  ));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.documentId, "signwell-doc-123");
  assert.equal(body.testMode, true);
  assert.equal(body.status, "sent");
  assert.equal(body.testSigningUrl, "https://www.signwell.com/docs/test-signing/");
  assert.equal(body.recipients[0].email, "jane@example.com");
  assert.equal(body.recipients[0].status, "sent");
  assert.equal(signWellRequest.files[0].file_url, "https://private-pdf.example.com/short-lived");
  assert.equal(signWellRequest.text_tags, true);
  assert.equal(signWellRequest.with_signature_page, false);
  assert.equal(signWellRequest.embedded_signing, true);
  assert.equal(signWellRequest.recipients[0].send_email, true);
  assert.deepEqual(signWellRequest.metadata, {
    workspaceId: "user-123",
    proposalId: "prp-sign",
    source: "rapidproposal",
  });
  assert.equal("apiKey" in body, false);
});

test("initials markers on a proposal with no agreement page still force SignWell text-tag parsing", async () => {
  let signWellRequest;
  const store = {
    async ensureWorkspace() {},
    async getProposal() {
      return {
        id: "prp-ini",
        name: "Services proposal",
        signerNames: ["Jane Client"],
        documentItems: [{ id: "scope", kind: "scope", hidden: false, initialFields: [{ id: "ini-1", xFrac: 0.5, yFracFromTop: 0.5 }] }],
      };
    },
    async updateProposalSignature(_w, _p, signatureRequest) { return signatureRequest; },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => ({
      webhookId: "webhook-123",
      client: {
        testMode: false,
        async createDocument(input) {
          signWellRequest = input;
          return { id: "signwell-doc-ini", status: "Sent", recipients: [{ id: "1", status: "sent" }] };
        },
      },
    }),
    getAssetSigner: async () => ({ async createDownloadUrl() { return "https://private.example.com/p.pdf"; } }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-ini/signature-requests",
    {
      assetKey: "exports/prp-ini.pdf",
      recipients: [{ name: "Jane Client", email: "jane@example.com" }],
      subject: "Please sign",
      message: "Please review and sign.",
      applySigningOrder: false,
    },
  ));

  assert.equal(response.statusCode, 201);
  assert.equal(signWellRequest.text_tags, true);
});

test("editing an untouched signer email updates the sent SignWell recipient and resends its notification", async () => {
  let proposal = {
    id: "prp-sign",
    name: "Dental modernization",
    signerNames: ["Jane Client"],
    documentItems: [{ id: "agreement", kind: "agreement", hidden: false }],
    signatureRequest: {
      provider: "signwell",
      documentId: "signwell-doc-old",
      status: "sent",
      testMode: false,
      subject: "Please sign",
      message: "Please review and sign.",
      applySigningOrder: false,
      recipients: [{ id: "1", name: "Jane Client", email: "wrong@example.com", status: "sent" }],
      sentAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  let recipientPatch;
  const store = {
    async ensureWorkspace() {},
    async getProposal() { return structuredClone(proposal); },
    async updateProposalSignature(_workspaceId, _proposalId, signatureRequest) {
      proposal = { ...proposal, signatureRequest: structuredClone(signatureRequest) };
      return signatureRequest;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => ({
      webhookId: "webhook-123",
      client: {
        testMode: false,
        async getDocument() {
          return {
            id: "signwell-doc-old",
            status: "Sent",
            metadata: { workspace_id: "user-123", proposal_id: "prp-sign" },
            recipients: [{ id: "1", name: "Jane Client", email: "wrong@example.com", status: "sent" }],
          };
        },
        async updateRecipients(documentId, recipients) {
          assert.equal(documentId, "signwell-doc-old");
          recipientPatch = recipients;
          return { id: documentId };
        },
      },
    }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-sign/signature-requests/resend",
    {
      assetKey: "exports/prp-sign.pdf",
      recipients: [{ name: "Jane Client", email: "correct@example.com" }],
      subject: "Please sign",
      message: "Please review and sign.",
      applySigningOrder: false,
    },
  ));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(recipientPatch, [{ id: "1", name: "Jane Client", email: "correct@example.com" }]);
  assert.equal(body.documentId, "signwell-doc-old");
  assert.equal(body.recipients[0].email, "correct@example.com");
  assert.equal(body.recipients[0].status, "sent");
  assert.ok(body.lastResentAt);
});

test("adding a signer and initials markers cancels the old request and sends a replacement draft", async () => {
  let proposal = {
    id: "prp-sign",
    name: "Dental modernization",
    signerNames: ["Jane Client", "Alex Client"],
    documentItems: [
      { id: "agreement", kind: "agreement", hidden: false },
      { id: "scope", kind: "scope", hidden: false, initialFields: [{ id: "ini-1", xFrac: 0.5, yFracFromTop: 0.5 }] },
    ],
    signatureRequest: {
      provider: "signwell",
      documentId: "signwell-doc-old",
      status: "sent",
      testMode: false,
      subject: "Please sign",
      message: "Please review and sign.",
      applySigningOrder: false,
      recipients: [{ id: "1", name: "Jane Client", email: "jane@example.com", status: "sent" }],
      sentAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const calls = [];
  let draftInput;
  const store = {
    async ensureWorkspace() {},
    async getProposal() { return structuredClone(proposal); },
    async updateProposalSignature(_workspaceId, _proposalId, signatureRequest) {
      proposal = { ...proposal, signatureRequest: structuredClone(signatureRequest) };
      return signatureRequest;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getAssetSigner: async () => ({ async createDownloadUrl() { return "https://private.example.com/proposal.pdf"; } }),
    getSignWell: async () => ({
      webhookId: "webhook-123",
      client: {
        testMode: false,
        async getDocument() {
          return {
            id: "signwell-doc-old",
            status: "Sent",
            metadata: { workspace_id: "user-123", proposal_id: "prp-sign" },
            recipients: [{ id: "1", name: "Jane Client", email: "jane@example.com", status: "sent" }],
          };
        },
        async createDocument(input) {
          calls.push("create-draft");
          draftInput = input;
          return { id: "signwell-doc-new", status: "Created", recipients: input.recipients };
        },
        async deleteDocument(documentId) {
          calls.push(`delete:${documentId}`);
        },
        async sendDocument(documentId) {
          calls.push(`send:${documentId}`);
          return {
            id: documentId,
            status: "Sent",
            recipients: [
              { id: "1", email: "jane@example.com", status: "sent" },
              { id: "2", email: "alex@example.com", status: "sent" },
            ],
          };
        },
      },
    }),
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-sign/signature-requests/resend",
    {
      assetKey: "exports/prp-sign.pdf",
      recipients: [
        { name: "Jane Client", email: "jane@example.com" },
        { name: "Alex Client", email: "alex@example.com" },
      ],
      subject: "Please sign",
      message: "Please review and sign.",
      applySigningOrder: false,
    },
  ));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ["create-draft", "delete:signwell-doc-old", "send:signwell-doc-new"]);
  assert.equal(draftInput.draft, true);
  assert.equal(draftInput.text_tags, true);
  assert.equal(draftInput.with_signature_page, false);
  assert.equal(body.documentId, "signwell-doc-new");
  assert.equal(body.replacedDocumentId, "signwell-doc-old");
  assert.equal(body.initials, undefined);
  assert.deepEqual(body.recipients.map((recipient) => recipient.email), ["jane@example.com", "alex@example.com"]);
});

test("completed PDF requests reconcile a missed SignWell completion webhook", async () => {
  let proposal = {
    id: "prp-sign",
    name: "Dental modernization",
    signatureRequest: {
      provider: "signwell",
      documentId: "signwell-doc-123",
      status: "sent",
      recipients: [{
        id: "1",
        name: "Jane Client",
        email: "jane@example.com",
        status: "pending",
      }],
      sentAt: "2026-08-31T17:30:00.000Z",
      updatedAt: "2026-08-31T17:30:00.000Z",
    },
  };
  const store = {
    async ensureWorkspace() {},
    async getProposal(workspaceId, proposalId) {
      assert.equal(workspaceId, "user-123");
      assert.equal(proposalId, "prp-sign");
      return structuredClone(proposal);
    },
    async updateProposalSignature(workspaceId, proposalId, signatureRequest) {
      assert.equal(workspaceId, "user-123");
      assert.equal(proposalId, "prp-sign");
      proposal = { ...proposal, signatureRequest: structuredClone(signatureRequest) };
      return signatureRequest;
    },
  };
  const signWell = {
    webhookId: "webhook-123",
    client: {
      async getDocument(documentId) {
        assert.equal(documentId, "signwell-doc-123");
        return {
          id: documentId,
          status: "Completed",
          updated_at: "2026-08-31T17:40:00.000Z",
          metadata: { workspace_id: "user-123", proposal_id: "prp-sign" },
          recipients: [{
            id: "1",
            name: "Jane Client",
            email: "JANE@example.com",
            status: "completed",
          }],
        };
      },
      async getCompletedPdfUrl(documentId) {
        assert.equal(documentId, "signwell-doc-123");
        return "https://signed.example.com/completed.pdf";
      },
      async getCompletedPdfBase64(documentId) {
        assert.equal(documentId, "signwell-doc-123");
        return Buffer.from("%PDF-1.4 signed").toString("base64");
      },
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => signWell,
  });

  const response = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-sign/signature-requests/completed-pdf",
  ));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.url, "https://signed.example.com/completed.pdf");
  assert.equal(Buffer.from(body.pdfBase64, "base64").toString(), "%PDF-1.4 signed");
  assert.equal(proposal.signatureRequest.status, "completed");
  assert.equal(proposal.signatureRequest.lastEvent, "document_completed");
  assert.equal(proposal.signatureRequest.completedAt, "2026-08-31T17:40:00.000Z");
  assert.equal(proposal.signatureRequest.recipients[0].status, "signed");
  assert.equal(proposal.signatureRequest.recipients[0].email, "jane@example.com");
  assert.equal(proposal.signatureRequest.recipients[0].signedAt, "2026-08-31T17:40:00.000Z");
});

test("proposal status refresh preserves SignWell sent and in-progress recipient states", async () => {
  let signatureRequest = {
    provider: "signwell",
    documentId: "signwell-doc-123",
    status: "sent",
    recipients: [
      { id: "1", name: "Jane Client", email: "jane@example.com", status: "pending" },
      { id: "2", name: "Alex Client", email: "alex@example.com", status: "pending" },
    ],
    sentAt: "2026-08-31T17:30:00.000Z",
    updatedAt: "2026-08-31T17:30:00.000Z",
  };
  const store = {
    async ensureWorkspace() {},
    async getProposal() {
      return { id: "prp-sign", signatureRequest: structuredClone(signatureRequest) };
    },
    async updateProposalSignature(_workspaceId, _proposalId, next) {
      signatureRequest = structuredClone(next);
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => ({
      webhookId: "webhook-123",
      client: {
        async getDocument() {
          return {
            id: "signwell-doc-123",
            status: "Sent",
            metadata: { workspace_id: "user-123", proposal_id: "prp-sign" },
            recipients: [
              { id: "1", name: "Jane Client", email: "jane@example.com", status: "sent" },
              { id: "2", name: "Alex Client", email: "alex@example.com", status: "in progress" },
            ],
          };
        },
      },
    }),
  });

  const response = await handler(authenticatedEvent("GET", "/workspaces/me/proposals/prp-sign"));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.signatureRequest.status, "sent");
  assert.deepEqual(
    body.signatureRequest.recipients.map((recipient) => recipient.status),
    ["sent", "in_progress"],
  );
});

test("proposal edits preserve server signature state and duplicates start unsigned", async () => {
  const signatureRequest = {
    provider: "signwell",
    documentId: "signwell-doc-123",
    status: "viewed",
    recipients: [{ id: "1", name: "Jane Client", email: "jane@example.com", status: "viewed" }],
  };
  const records = new Map([["user-123:prp-sign", {
    id: "prp-sign",
    name: "Original proposal",
    status: "draft",
    signatureRequest,
  }]]);
  const store = {
    async ensureWorkspace() {},
    async getProposal(workspaceId, proposalId) {
      return records.get(`${workspaceId}:${proposalId}`) ?? null;
    },
    async putProposal(workspaceId, proposal) {
      records.set(`${workspaceId}:${proposal.id}`, structuredClone(proposal));
      return proposal;
    },
    async createProposal(workspaceId, proposal) {
      records.set(`${workspaceId}:${proposal.id}`, structuredClone(proposal));
      return proposal;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const updated = await handler(authenticatedEvent(
    "PATCH",
    "/workspaces/me/proposals/prp-sign",
    { id: "prp-sign", name: "Edited in an older tab", status: "draft" },
  ));
  const duplicated = await handler(authenticatedEvent(
    "POST",
    "/workspaces/me/proposals/prp-sign/duplicate",
  ));

  assert.deepEqual(JSON.parse(updated.body).signatureRequest, signatureRequest);
  assert.equal("signatureRequest" in JSON.parse(duplicated.body), false);
});

test("SignWell webhooks require the documented HMAC and update only the matching proposal document", async () => {
  const webhookId = "webhook-123";
  let signatureRequest = {
    provider: "signwell",
    documentId: "signwell-doc-123",
    status: "sent",
    recipients: [{ id: "1", name: "Jane Client", email: "jane@example.com", status: "pending" }],
  };
  const store = {
    async getProposal(workspaceId, proposalId) {
      assert.equal(workspaceId, "workspace-123");
      assert.equal(proposalId, "prp-sign");
      return { id: proposalId, signatureRequest };
    },
    async updateProposalSignature(_workspaceId, _proposalId, next) {
      signatureRequest = next;
    },
  };
  const type = "document_completed";
  const time = 1788144000;
  const hash = createHmac("sha256", webhookId).update(`${type}@${time}`).digest("hex");
  const payload = {
    event: {
      type,
      time,
      hash,
      related_signer: { name: "Jane Client", email: "jane@example.com" },
    },
    data: {
      object: {
        id: "signwell-doc-123",
        metadata: { workspace_id: "workspace-123", proposal_id: "prp-sign" },
        recipients: [{ id: "1", name: "Jane Client", email: "jane@example.com" }],
      },
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getSignWell: async () => ({ webhookId, client: {} }),
  });

  const valid = await handler({
    requestContext: { http: { method: "POST", path: "/webhooks/signwell" } },
    rawPath: "/webhooks/signwell",
    body: JSON.stringify(payload),
  });
  const invalid = await handler({
    requestContext: { http: { method: "POST", path: "/webhooks/signwell" } },
    rawPath: "/webhooks/signwell",
    body: JSON.stringify({ ...payload, event: { ...payload.event, hash: "0".repeat(64) } }),
  });

  assert.equal(valid.statusCode, 200);
  assert.equal(signatureRequest.status, "completed");
  assert.equal(signatureRequest.completedAt, new Date(time * 1000).toISOString());
  assert.equal(signatureRequest.recipients[0].status, "signed");
  assert.equal(invalid.statusCode, 401);
});

test("workspace membership shares proposal data across Cognito users", async () => {
  const store = {
    async getMembership(userId) {
      return {
        userId,
        workspaceId: "workspace-technovate",
        role: "quotation-builder",
        status: "active",
      };
    },
    async ensureWorkspace() {},
    async listProposals(workspaceId) {
      assert.equal(workspaceId, "workspace-technovate");
      return [{ id: "prp-shared", name: "Shared proposal" }];
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent("GET", "/workspaces/me/proposals");
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "[\"quotation-builder\"]";

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body)[0].id, "prp-shared");
});

test("quotation builders cannot access non-proposal workspace APIs", async () => {
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-123", role: "quotation-builder", status: "active" };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent("GET", "/workspaces/me/agents");
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "quotation-builder";

  const response = await handler(event);

  assert.equal(response.statusCode, 403);
});

test("company administrators can provision quotation builders", async () => {
  const memberships = [];
  const directoryCalls = [];
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-123", role: "company-admin", status: "active" };
    },
    async putMembership(membership) {
      memberships.push(membership);
      return membership;
    },
  };
  const directory = {
    async createUser(input) {
      directoryCalls.push(["create", input.email]);
      return { userId: "member-123", username: "cognito-member-123" };
    },
    async setRole(username, role) {
      directoryCalls.push(["role", username, role]);
    },
    async deleteUser() {},
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getUserDirectory: async () => directory,
  });
  const event = authenticatedEvent("POST", "/workspaces/me/users", {
    email: "builder@example.com",
    name: "Proposal Builder",
    role: "quotation-builder",
    temporaryPassword: "Temporary123!",
  });
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 201);
  assert.equal(memberships[0].workspaceId, "workspace-123");
  assert.equal(memberships[0].role, "quotation-builder");
  assert.deepEqual(directoryCalls, [
    ["create", "builder@example.com"],
    ["role", "cognito-member-123", "quotation-builder"],
  ]);
});

test("company administrators can provision another company administrator", async () => {
  const memberships = [];
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-123", role: "company-admin", status: "active" };
    },
    async putMembership(membership) {
      memberships.push(membership);
      return membership;
    },
  };
  const directory = {
    async createUser() {
      return { userId: "admin-456", username: "cognito-admin-456" };
    },
    async setRole(_username, role) {
      assert.equal(role, "company-admin");
    },
    async deleteUser() {},
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getUserDirectory: async () => directory,
  });
  const event = authenticatedEvent("POST", "/workspaces/me/users", {
    email: "ADMIN2@EXAMPLE.COM",
    name: "Second Admin",
    role: "company-admin",
    temporaryPassword: "Temporary123!",
  });
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 201);
  assert.equal(memberships[0].email, "admin2@example.com");
  assert.equal(memberships[0].role, "company-admin");
});

test("company administrators cannot change a super administrator", async () => {
  const store = {
    async getMembership(userId) {
      if (userId === "platform-user") {
        return {
          userId,
          cognitoUsername: "platform-user@example.com",
          workspaceId: "workspace-123",
          role: "company-admin",
          status: "active",
        };
      }
      return { userId, workspaceId: "workspace-123", role: "company-admin", status: "active" };
    },
  };
  const directory = {
    async getRoles() { return ["super-admin"]; },
    async setRole() { assert.fail("protected roles must not be changed"); },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getUserDirectory: async () => directory,
  });
  const event = authenticatedEvent("PATCH", "/workspaces/me/users/platform-user", {
    role: "quotation-builder",
  });
  event.pathParameters = { userId: "platform-user" };
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 403);
});

test("super administrators onboard a company with an isolated default template", async () => {
  let bundle;
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
    },
    async createWorkspaceBundle(value) {
      bundle = value;
      return value;
    },
  };
  const directoryCalls = [];
  const directory = {
    async createUser(input) {
      directoryCalls.push(["create", input]);
      return { userId: "company-admin-123", username: "cognito-company-admin-123" };
    },
    async setRole(username, role) {
      directoryCalls.push(["role", username, role]);
    },
    async deleteUser() {},
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getUserDirectory: async () => directory,
  });
  const event = authenticatedEvent("POST", "/platform/companies", {
    name: "Technovate Design",
    adminEmail: "AJM@technovate.design",
    adminName: "AJM",
    temporaryPassword: "Temporary123!",
    tier: "repository",
    allowedProposalSections: ["cover", "agenda", "parts", "closing"],
    defaultTemplateSections: ["cover", "agenda", "closing"],
  });
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "[\"super-admin\"]";

  const response = await handler(event);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.match(body.workspaceId, /^workspace-/);
  assert.equal(body.templateCount, 1);
  assert.equal(bundle.workspace.name, "Technovate Design");
  assert.equal(bundle.workspace.tier, "repository");
  assert.deepEqual(bundle.workspace.allowedProposalSections, ["cover", "agenda", "parts", "closing"]);
  assert.equal(bundle.membership.email, "ajm@technovate.design");
  assert.equal(bundle.membership.role, "company-admin");
  assert.equal(bundle.template.name, "Default");
  assert.equal(bundle.template.isDefault, true);
  assert.deepEqual(bundle.template.items.map((item) => item.kind), ["cover", "agenda", "closing"]);
  assert.deepEqual(directoryCalls.map((call) => call[0]), ["create", "role"]);
});

test("only super administrators can access company onboarding", async () => {
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-123", role: "company-admin", status: "active" };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent("GET", "/platform/companies");
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 403);
});

test("super administrators can attach a validated logo to an onboarded company", async () => {
  let workspace = { workspaceId: "workspace-technovate", name: "Technovate Design" };
  const signerCalls = [];
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      assert.equal(workspaceId, workspace.workspaceId);
      return workspace;
    },
    async putWorkspace(value) {
      workspace = value;
      return value;
    },
  };
  const signer = {
    async createImageUpload(...args) {
      signerCalls.push(args);
      return { url: "https://upload.example.com", fields: { policy: "signed-policy" } };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getAssetSigner: async () => signer,
  });
  const uploadEvent = authenticatedEvent(
    "POST",
    "/platform/companies/workspace-technovate/logo/upload-url",
    { contentType: "image/webp", bytes: 512_000 },
  );
  uploadEvent.pathParameters = { workspaceId: "workspace-technovate" };
  uploadEvent.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";
  const uploadResponse = await handler(uploadEvent);
  const upload = JSON.parse(uploadResponse.body);

  const completeEvent = authenticatedEvent(
    "POST",
    "/platform/companies/workspace-technovate/logo/complete",
    { key: upload.key, contentType: "image/webp", bytes: 512_000 },
  );
  completeEvent.pathParameters = { workspaceId: "workspace-technovate" };
  completeEvent.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";
  const completeResponse = await handler(completeEvent);

  assert.equal(uploadResponse.statusCode, 200);
  assert.match(upload.key, /^company\/logo-/);
  assert.deepEqual(signerCalls, [[
    "workspace-technovate",
    upload.key,
    "image/webp",
    10 * 1024 * 1024,
  ]]);
  assert.equal(completeResponse.statusCode, 200);
  assert.equal(workspace.companyLogo.key, upload.key);
  assert.equal(workspace.companyLogo.contentType, "image/webp");
});

test("company logo upload rejects non-images and files larger than 10 MB", async () => {
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      return { workspaceId, name: "Technovate Design" };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const requests = [
    { contentType: "application/pdf", bytes: 100 },
    { contentType: "image/png", bytes: 10 * 1024 * 1024 + 1 },
  ];

  for (const body of requests) {
    const event = authenticatedEvent(
      "POST",
      "/platform/companies/workspace-technovate/logo/upload-url",
      body,
    );
    event.pathParameters = { workspaceId: "workspace-technovate" };
    event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";
    assert.equal((await handler(event)).statusCode, 400);
  }
});

test("super administrators can list users in a company workspace", async () => {
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      assert.equal(workspaceId, "workspace-technovate");
      return { workspaceId, name: "Technovate Design" };
    },
    async listMemberships(workspaceId) {
      assert.equal(workspaceId, "workspace-technovate");
      return [{
        userId: "member-123",
        workspaceId,
        email: "ajm@technovate.design",
        name: "AJM",
        role: "company-admin",
        status: "active",
        createdAt: "2026-08-19T00:00:00.000Z",
      }];
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent(
    "GET",
    "/platform/companies/workspace-technovate/users",
  );
  event.pathParameters = { workspaceId: "workspace-technovate" };
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";

  const response = await handler(event);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].email, "ajm@technovate.design");
});

test("super administrators can rename a company and change its plan", async () => {
  let saved;
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      return {
        workspaceId,
        name: "Old Company Name",
        tier: "basic",
        allowedProposalSections: ["cover", "closing"],
        createdAt: "2026-08-19T00:00:00.000Z",
      };
    },
    async putWorkspace(workspace) {
      saved = workspace;
      return workspace;
    },
    async listMemberships() { return []; },
    async listProposals() { return []; },
    async listProposalTemplates() { return []; },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent(
    "PATCH",
    "/platform/companies/workspace-technovate",
    { name: "Technovate Design", tier: "signing" },
  );
  event.pathParameters = { workspaceId: "workspace-technovate" };
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";

  const response = await handler(event);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(saved.name, "Technovate Design");
  assert.equal(saved.tier, "signing");
  assert.equal(body.name, "Technovate Design");
  assert.equal(body.tier, "signing");
});

test("super administrators can update a company user's role", async () => {
  let saved;
  const directoryCalls = [];
  const store = {
    async getMembership(userId) {
      if (userId === "user-123") {
        return { userId, workspaceId: "workspace-platform", role: "company-admin", status: "active" };
      }
      return {
        userId,
        cognitoUsername: "member-cognito",
        workspaceId: "workspace-technovate",
        email: "member@technovate.design",
        role: "quotation-builder",
        status: "active",
      };
    },
    async getWorkspace(workspaceId) {
      return { workspaceId, name: "Technovate Design" };
    },
    async putMembership(membership) {
      saved = membership;
      return membership;
    },
  };
  const directory = {
    async getRoles(username) {
      directoryCalls.push(["roles", username]);
      return ["quotation-builder"];
    },
    async setRole(username, role) {
      directoryCalls.push(["set", username, role]);
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getUserDirectory: async () => directory,
  });
  const event = authenticatedEvent(
    "PATCH",
    "/platform/companies/workspace-technovate/users/member-123",
    { role: "company-admin" },
  );
  event.pathParameters = {
    workspaceId: "workspace-technovate",
    userId: "member-123",
  };
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.equal(saved.role, "company-admin");
  assert.deepEqual(directoryCalls, [
    ["roles", "member-cognito"],
    ["set", "member-cognito", "company-admin"],
  ]);
});

test("company profile APIs read and update the signed-in workspace name", async () => {
  let workspace = {
    workspaceId: "workspace-technovate",
    name: "Technovate Design",
    tier: "basic",
  };
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: workspace.workspaceId, role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      assert.equal(workspaceId, workspace.workspaceId);
      return workspace;
    },
    async putWorkspace(value) {
      workspace = value;
      return value;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const getEvent = authenticatedEvent("GET", "/workspaces/me/company");
  getEvent.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";
  const getResponse = await handler(getEvent);

  const patchEvent = authenticatedEvent(
    "PATCH",
    "/workspaces/me/company",
    { name: "Technovate Group" },
  );
  patchEvent.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";
  const patchResponse = await handler(patchEvent);

  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(getResponse.body), { name: "Technovate Design", logo: null });
  assert.equal(patchResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(patchResponse.body), { name: "Technovate Group" });
  assert.equal(workspace.name, "Technovate Group");
  assert.equal(workspace.tier, "basic");
});

test("company administrators can upload, read, and remove their company logo", async () => {
  let workspace = { workspaceId: "workspace-technovate", name: "Technovate Design" };
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: workspace.workspaceId, role: "company-admin", status: "active" };
    },
    async getWorkspace() { return workspace; },
    async putWorkspace(value) { workspace = value; return value; },
  };
  const signer = {
    async createImageUpload() {
      return { url: "https://upload.example.com", fields: { policy: "signed-policy" } };
    },
    async createDownloadUrl(workspaceId, key) {
      return `https://download.example.com/${workspaceId}/${key}`;
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getAssetSigner: async () => signer,
  });
  const withRole = (event) => {
    event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";
    return event;
  };
  const uploadResponse = await handler(withRole(authenticatedEvent(
    "POST",
    "/workspaces/me/company/logo/upload-url",
    { contentType: "image/png", bytes: 4096 },
  )));
  const upload = JSON.parse(uploadResponse.body);
  const completeResponse = await handler(withRole(authenticatedEvent(
    "POST",
    "/workspaces/me/company/logo/complete",
    { key: upload.key, contentType: "image/png", bytes: 4096 },
  )));
  const getResponse = await handler(withRole(authenticatedEvent(
    "GET",
    "/workspaces/me/company",
  )));
  const removeResponse = await handler(withRole(authenticatedEvent(
    "DELETE",
    "/workspaces/me/company/logo",
  )));

  assert.equal(uploadResponse.statusCode, 200);
  assert.equal(completeResponse.statusCode, 200);
  assert.match(JSON.parse(getResponse.body).logo.url, /^https:\/\/download\.example\.com/);
  assert.equal(removeResponse.statusCode, 200);
  assert.equal(workspace.companyLogo, undefined);
});

test("company administrators receive their allowed proposal sections", async () => {
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-123", role: "company-admin", status: "active" };
    },
    async getWorkspace(workspaceId) {
      assert.equal(workspaceId, "workspace-123");
      return {
        workspaceId,
        allowedProposalSections: ["cover", "parts", "closing"],
        tier: "repository",
      };
    },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent("GET", "/workspaces/me/proposal-settings");
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "company-admin";

  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    allowedProposalSections: ["cover", "parts", "closing"],
    tier: "repository",
  });
});

test("Cognito directory rejects an existing email regardless of capitalization", async () => {
  class ListUsersCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class AdminCreateUserCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      if (command instanceof ListUsersCommand) {
        return {
          Users: [{
            Username: "existing-user",
            Attributes: [{ Name: "email", Value: "AJM@technovate.design" }],
          }],
        };
      }
      throw new Error("AdminCreateUser must not be called for a duplicate email");
    },
  };
  const { createCognitoDirectory } = await loadBff();
  const directory = createCognitoDirectory(client, {
    ListUsersCommand,
    AdminCreateUserCommand,
  }, "pool-123");

  await assert.rejects(
    directory.createUser({
      email: "ajm@technovate.design",
      name: "Duplicate",
      temporaryPassword: "Temporary123!",
    }),
    { name: "UsernameExistsException" },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof ListUsersCommand);
});

test("S3 asset signer matches the AWS Signature Version 4 reference output", async () => {
  const { createS3AssetSigner } = await loadBff();
  const signer = createS3AssetSigner({
    bucket: "proposal-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token",
    },
    now: () => new Date("2026-08-18T12:34:56.000Z"),
  });

  assert.equal(
    signer.createDownloadUrl("user-123", "proposals/proposal.pdf"),
    "https://proposal-bucket.s3.us-east-1.amazonaws.com/workspaces/user-123/proposals/proposal.pdf" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD" +
      "&X-Amz-Credential=AKIDEXAMPLE%2F20260818%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260818T123456Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-Security-Token=session-token" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=c72ec1c4f6b4255b22156aaf66639ef6ac9eb1f9e818360811a01255a608380a",
  );
});

test("S3 image upload signer enforces content type and a 10 MB form limit", async () => {
  const { createS3AssetSigner } = await loadBff();
  const signer = createS3AssetSigner({
    bucket: "proposal-bucket",
    region: "us-east-1",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token",
    },
    now: () => new Date("2026-08-18T12:34:56.000Z"),
  });

  const post = signer.createImageUpload(
    "workspace-123",
    "company/logo-12345678-1234-4123-8123-123456789abc",
    "image/png",
    10 * 1024 * 1024,
  );
  const policy = JSON.parse(Buffer.from(post.fields.policy, "base64").toString("utf8"));

  assert.equal(post.url, "https://proposal-bucket.s3.us-east-1.amazonaws.com");
  assert.equal(post.fields["Content-Type"], "image/png");
  assert.equal(post.fields.key, "workspaces/workspace-123/company/logo-12345678-1234-4123-8123-123456789abc");
  assert.ok(post.fields["x-amz-signature"]);
  assert.deepEqual(
    policy.conditions.find((condition) => Array.isArray(condition)),
    ["content-length-range", 1, 10 * 1024 * 1024],
  );
  assert.ok(policy.conditions.some((condition) => condition["Content-Type"] === "image/png"));
});

function authenticatedEvent(method, path, body, queryStringParameters) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: "user-123" } } },
      http: { method, path },
    },
    rawPath: path,
    ...(queryStringParameters ? { queryStringParameters } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function receptionistAgent() {
  return {
    id: "agent-123",
    name: "Maya",
    role: "Phone operations",
    description: "Answers calls",
    status: "draft",
    tested: true,
    testedAt: "2026-08-16T13:00:00.000Z",
    capabilities: ["Inbound calls", "Calendar"],
    configuration: {
      template: "receptionist",
      businessConfirmed: true,
      name: "Maya",
      voice: "Calm and natural",
      tone: "Warm and concise",
      greeting: "Thanks for calling Arc Dental.",
      guidance: "Never provide a diagnosis.",
      intents: ["Scheduling", "Insurance"],
      booking: true,
      connections: ["google-calendar"],
      calendarSelectionId: "primary",
      phone: "+17035550133",
      escalation: "Transfer emergencies to the office.",
      tested: false,
    },
  };
}

function receptionistProfile() {
  return {
    businessName: "Arc Dental",
    businessType: "dental",
    description: "Family dental care",
    address: "123 Main Street",
    timezone: "America/New_York",
    hours: "Mon-Fri, 8:00 AM-5:00 PM",
    phone: "+17035550133",
    faqs: [{
      question: "Do you accept insurance?",
      answer: "Yes.",
    }],
    policies: "Call before cancelling.",
    escalationContact: "+17035550199",
    ownerPhone: "+17035550100",
    fallbackPhone: "+17035550188",
    communicationStyle: "Warm and concise",
  };
}

// ---------------------------------------------------------------------------
// Feature 2 - minute metering, plans, overage and billing
// ---------------------------------------------------------------------------

function superAdminEvent(method, path, body, queryStringParameters) {
  const event = authenticatedEvent(method, path, body, queryStringParameters);
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";
  return event;
}

function meteringStore(overrides = {}) {
  return {
    async ensureWorkspace() {},
    async getProfile() {
      return { ...receptionistProfile(), receptionistPlan: "starter" };
    },
    async getWorkspace() {
      return { workspaceId: "workspace-123", name: "Arc Dental" };
    },
    async putWorkspace(value) {
      return value;
    },
    async putProfile(_workspaceId, value) {
      return value;
    },
    async listCalls() {
      return [];
    },
    ...overrides,
  };
}

const minuteCall = (startedAt, durationMs) => ({
  callId: `call-${startedAt}`,
  startedAt,
  durationMs,
  outcome: "answered",
});

test("GET /workspaces/me/usage returns a tz-correct billing cycle with no cost data", async () => {
  const { createHandler } = await loadBff();
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const store = meteringStore({
    async listCalls() {
      return [
        minuteCall(`${period}-05T10:00:00-04:00`, 90_000),
        minuteCall(`${period}-06T11:00:00-04:00`, 30_000),
      ];
    },
  });
  const handler = createHandler({ getStore: async () => store });
  const response = await handler(authenticatedEvent("GET", "/workspaces/me/usage"));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.plan, "starter");
  assert.equal(body.minuteAllowance, 1000);
  assert.equal(body.billingCycle.minutes, 3);
  assert.equal(body.billingCycle.usageState, "ok");
  assert.equal(body.cost, undefined);
  assert.ok(Array.isArray(body.calls));
});

test("PUT /workspaces/me/profile queues a downgrade for next cycle", async () => {
  const { createHandler } = await loadBff();
  let savedWorkspace;
  let savedProfile;
  const store = meteringStore({
    async getProfile() {
      return { ...receptionistProfile(), receptionistPlan: "growth" };
    },
    async putWorkspace(value) {
      savedWorkspace = value;
      return value;
    },
    async putProfile(_workspaceId, value) {
      savedProfile = value;
      return value;
    },
  });
  const handler = createHandler({ getStore: async () => store });
  const response = await handler(authenticatedEvent("PUT", "/workspaces/me/profile", {
    ...receptionistProfile(),
    receptionistPlan: "starter",
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(savedProfile.receptionistPlan, "growth");
  assert.equal(savedWorkspace.receptionistPlanPending, "starter");
  assert.match(savedWorkspace.receptionistPlanPendingFrom, /^\d{4}-\d{2}$/);
  assert.equal(savedWorkspace.planHistory.at(-1).plan, "Starter");
});

test("PUT /workspaces/me/profile applies an upgrade immediately", async () => {
  const { createHandler } = await loadBff();
  let savedProfile;
  const store = meteringStore({
    async getProfile() {
      return { ...receptionistProfile(), receptionistPlan: "starter" };
    },
    async putProfile(_workspaceId, value) {
      savedProfile = value;
      return value;
    },
  });
  const handler = createHandler({ getStore: async () => store });
  const response = await handler(authenticatedEvent("PUT", "/workspaces/me/profile", {
    ...receptionistProfile(),
    receptionistPlan: "pro",
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(savedProfile.receptionistPlan, "pro");
});

test("PUT /workspaces/me/profile rejects an unknown plan key", async () => {
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => meteringStore() });
  const response = await handler(authenticatedEvent("PUT", "/workspaces/me/profile", {
    ...receptionistProfile(),
    receptionistPlan: "platinum",
  }));
  assert.equal(response.statusCode, 400);
});

test("inbound lookup rejects the call once the overage cap is reached", async () => {
  const { createHandler } = await loadBff();
  const store = {
    async getPhoneNumberByDid() {
      return { workspaceId: "workspace-123", agentId: "agent-123" };
    },
    async getAgent() {
      return { status: "active", retellAgentId: "retell-agent-1" };
    },
    async getProfile() {
      return { ...receptionistProfile(), receptionistPlan: "starter" };
    },
    async getWorkspace() {
      return { workspaceId: "workspace-123" };
    },
    async getUsageCounter() {
      return { billedMinutes: 2200 };
    },
  };
  const handler = createHandler({
    getStore: async () => store,
    getRetellApiKey: async () => "retell-secret",
    verifySignature: () => true,
  });
  const response = await handler({
    requestContext: { http: { method: "POST", path: "/retell/inbound-lookup" } },
    rawPath: "/retell/inbound-lookup",
    headers: { "x-retell-signature": "v=1,d=deadbeef" },
    body: JSON.stringify({
      event: "call_inbound",
      call_inbound: { to_number: "+17035550100" },
    }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { call_inbound: { reject: true } });
});

test("GET /platform/billing aggregates workspaces and is super-admin only", async () => {
  const { createHandler } = await loadBff();
  const workspaces = [
    { workspaceId: "ws-a", name: "Alpha" },
    { workspaceId: "ws-b", name: "Bravo" },
  ];
  const profiles = {
    "ws-a": { timezone: "UTC", receptionistPlan: "starter" },
    "ws-b": { timezone: "UTC", receptionistPlan: "" },
  };
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "ws-platform", role: "super-admin", status: "active" };
    },
    async ensureWorkspace() {},
    async getProfile(id) {
      return profiles[id] ?? null;
    },
    async getWorkspace(id) {
      return workspaces.find((w) => w.workspaceId === id) ?? null;
    },
    async listWorkspaces() {
      return workspaces;
    },
    async listCalls(id) {
      return id === "ws-a"
        ? Array.from({ length: 20 }, (_, i) => minuteCall(`${period}-02T10:${String(i).padStart(2, "0")}:00Z`, 60_000))
        : [];
    },
    async listMemberships() { return []; },
    async listProposals() { return []; },
    async listProposalTemplates() { return []; },
  };
  const handler = createHandler({ getStore: async () => store });

  const forbidden = await createHandler({ getStore: async () => ({ async ensureWorkspace() {} }) })(
    authenticatedEvent("GET", "/platform/billing"),
  );
  assert.equal(forbidden.statusCode, 403);

  const response = await handler(superAdminEvent("GET", "/platform/billing"));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.rows.length, 2);
  const alpha = body.rows.find((row) => row.workspaceId === "ws-a");
  assert.equal(alpha.minutesUsed, 20);
  assert.equal(alpha.totalDue, 349);
  assert.equal(typeof alpha.grossMarginPct, "number");
  const bravo = body.rows.find((row) => row.workspaceId === "ws-b");
  assert.equal(bravo.totalDue, null);
});

test("PATCH /platform/companies sets a plan override with custom Enterprise numbers", async () => {
  const { createHandler } = await loadBff();
  let saved;
  const store = {
    async getMembership(userId) {
      return { userId, workspaceId: "ws-platform", role: "super-admin", status: "active" };
    },
    async ensureWorkspace() {},
    async getWorkspace() {
      return { workspaceId: "ws-tech", name: "Technovate" };
    },
    async putWorkspace(value) {
      saved = value;
      return value;
    },
    async getProfile() { return null; },
    async listCalls() { return []; },
    async listMemberships() { return []; },
    async listProposals() { return []; },
    async listProposalTemplates() { return []; },
  };
  const handler = createHandler({ getStore: async () => store });
  const event = authenticatedEvent("PATCH", "/platform/companies/ws-tech", {
    receptionistPlanOverride: "enterprise",
    enterpriseMinutes: 8000,
    enterprisePriceMonthly: 1999,
    enterpriseOveragePerMinute: 0.25,
  });
  event.pathParameters = { workspaceId: "ws-tech" };
  event.requestContext.authorizer.jwt.claims["cognito:groups"] = "super-admin";
  const response = await handler(event);

  assert.equal(response.statusCode, 200);
  assert.equal(saved.receptionistPlanOverride, "enterprise");
  assert.equal(saved.enterpriseMinutes, 8000);
  assert.equal(saved.planHistory.at(-1).plan, "Enterprise");
});

test("Dynamo list reads page past the 1 MB limit and skip strong consistency", async () => {
  class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const inputs = [];
  const pages = [
    { Items: [{ workspaceId: { S: "ws-1" }, proposalId: { S: "prp-1" }, name: { S: "One" } }], LastEvaluatedKey: { proposalId: { S: "prp-1" } } },
    { Items: [{ workspaceId: { S: "ws-1" }, proposalId: { S: "prp-2" }, name: { S: "Two" } }] },
  ];
  const client = {
    async send(command) {
      inputs.push(command.input);
      return pages[inputs.length - 1] ?? { Items: [] };
    },
  };
  const { createDynamoStore } = await loadBff();
  const store = createDynamoStore(client, { QueryCommand }, { proposals: "proposals-table" });

  const proposals = await store.listProposals("ws-1");

  assert.deepEqual(proposals.map((item) => item.id), ["prp-1", "prp-2"]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].ConsistentRead, undefined);
  assert.deepEqual(inputs[1].ExclusiveStartKey, { proposalId: { S: "prp-1" } });
});

test("Dynamo countProposals uses Select COUNT without shipping item bodies", async () => {
  class QueryCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const inputs = [];
  const client = {
    async send(command) {
      inputs.push(command.input);
      return inputs.length === 1
        ? { Count: 40, LastEvaluatedKey: { proposalId: { S: "prp-40" } } }
        : { Count: 12 };
    },
  };
  const { createDynamoStore } = await loadBff();
  const store = createDynamoStore(client, { QueryCommand }, { proposals: "proposals-table" });

  const count = await store.countProposals("ws-1");

  assert.equal(count, 52);
  assert.equal(inputs[0].Select, "COUNT");
  assert.equal(inputs[0].ProjectionExpression, undefined);
});
