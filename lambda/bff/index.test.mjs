import assert from "node:assert/strict";
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
    services: ["Cleanings"],
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
    recordingUrl: "https://retell.example/recording.wav",
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
  }]);
  assert.doesNotMatch(response.body, /retell-call-secret/);
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
        recordingUrl: "https://retell.example/recording.wav",
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
    recordingUrl: "https://retell.example/recording.wav",
    outcome: "answered",
  });
  assert.doesNotMatch(response.body, /retell-call-secret/);
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
  assert.deepEqual(phoneCallInput, {
    fromNumber: "+17035550177",
    toNumber: "+17035550100",
    retellAgentId: "retell-agent-123",
    workspaceId: "user-123",
    agentId: "agent-123",
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
  assert.deepEqual(JSON.parse(response.body), {
    call_inbound: {
      override_agent_id: "retell-agent-123",
      dynamic_variables: {
        workspaceId: "workspace-123",
        agentId: "agent-123",
      },
      metadata: {
        workspaceId: "workspace-123",
        agentId: "agent-123",
      },
    },
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

function authenticatedEvent(method, path, body) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: "user-123" } } },
      http: { method, path },
    },
    rawPath: path,
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
    services: ["Cleanings"],
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
