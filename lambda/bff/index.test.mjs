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
    async putAgent(workspaceId, agentId, agent) {
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
