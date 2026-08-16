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
  assert.deepEqual(JSON.parse(created.body), agent);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(JSON.parse(listed.body), [agent]);
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
  assert.deepEqual(JSON.parse(response.body), agent);
  assert.deepEqual(calls, [["user-123", "agent-123", agent]]);
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
    events.findIndex(([name]) => name === "putPhoneNumber") <
      events.findIndex(([name]) => name === "retell"),
  );
  const retellInput = events.find(([name]) => name === "retell")[1];
  assert.equal(retellInput.symanticAgentId, "agent-123");
  assert.match(retellInput.config.prompt, /Mon-Fri, 8:00 AM-5:00 PM/);
  assert.ok(retellInput.config.tools.every(({ url }) =>
    url.startsWith("https://api.example.com/retell/tools/")
  ));
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
    async getPhoneNumberForAgent() {
      return {
        workspaceId: "user-123",
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxNumberId: "telnyx-number-123",
        telnyxPhoneNumber: "+17035550177",
      };
    },
    async updateAgentRuntime(_workspaceId, _agentId, updates) {
      runtimeUpdates.push(updates);
      if (runtimeUpdates.length === 1) {
        return { ...agent, ...updates };
      }
      throw new Error("status update failed");
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
    async getPhoneNumberForAgent() {
      return {
        workspaceId: "user-123",
        phoneNumberId: "phone-agent-123",
        agentId: "agent-123",
        telnyxNumberId: "telnyx-number-existing",
        telnyxPhoneNumber: "+17035550166",
      };
    },
    async updateAgentRuntime(_workspaceId, _agentId, updates) {
      return { ...agent, ...updates };
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
    async getPhoneNumberForAgent() {
      return {
        phoneNumberId: "phone-agent-123",
        telnyxPhoneNumber: "+17035550177",
      };
    },
    async updateAgentRuntime() {
      assert.fail("start-test-call must not update tested or testedAt");
    },
  };
  let phoneCallInput;
  const { createHandler } = await loadBff();
  const handler = createHandler({
    getStore: async () => store,
    getProviders: async () => ({
      retell: {
        async startPhoneCall(input) {
          phoneCallInput = input;
          return { callId: "call-123", status: "registered" };
        },
      },
    }),
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

test("POST inbound lookup verifies Retell signature and resolves DID to live config", async () => {
  const rawBody = JSON.stringify({ to_number: "+17035550177" });
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
      return receptionistAgent();
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
  assert.match(body.prompt, /Arc Dental/);
  assert.equal(body.voice, "retell-Cimo");
  assert.equal(body.bookingEnabled, true);
  assert.deepEqual(body.transferNumbers, [
    "+17035550199",
    "+17035550100",
    "+17035550188",
  ]);
  assert.equal(body.tools.length, 7);
  assert.deepEqual(Object.keys(body).sort(), [
    "bookingEnabled",
    "prompt",
    "tools",
    "transferNumbers",
    "voice",
  ]);
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
    body: JSON.stringify({ to_number: "+17035550177" }),
  });

  assert.equal(response.statusCode, 401);
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
    capabilities: ["Inbound calls", "Calendar"],
    configuration: {
      name: "Maya",
      voice: "Calm and natural",
      tone: "Warm and concise",
      greeting: "Thanks for calling Arc Dental.",
      guidance: "Never provide a diagnosis.",
      intents: ["Scheduling", "Insurance"],
      booking: true,
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
