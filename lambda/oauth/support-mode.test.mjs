import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandler,
  createInMemoryConnectionStore,
  createInMemoryMembershipStore,
  createInMemoryStateStore,
} from "./index.mjs";

// Support mode: a super administrator (own workspace "workspace-symantic-ai")
// working inside a company ("workspace-cwr") through Manage Company Accounts
// > Support. Calendar requests must act on that company, exactly like the
// BFF - otherwise the calendar is read from, and saved to, the super admin's
// own workspace, where the company's agent never uses it.
const SUPER_ADMIN_SUB = "sub-super";
const OWN = "workspace-symantic-ai";
const CWR = "workspace-cwr";
const AGENT = "agent-dolly";

function request(method, path, { groups = ["super-admin"], support, query, body } = {}) {
  return {
    rawPath: path,
    requestContext: {
      http: { method, path },
      authorizer: { jwt: { claims: { sub: SUPER_ADMIN_SUB, email: "admin@symantic.ai", "cognito:groups": groups } } },
    },
    headers: support === undefined ? {} : { "X-Support-Workspace": support },
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function setup({ workspaces = [OWN, CWR], connections = [] } = {}) {
  const stateStore = createInMemoryStateStore();
  const connectionStore = createInMemoryConnectionStore(connections);
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getConnectionStore: async () => connectionStore,
    getMembershipStore: async () => createInMemoryMembershipStore([
      { userId: SUPER_ADMIN_SUB, workspaceId: OWN, status: "active" },
    ]),
    getWorkspaceStore: async () => ({
      async getWorkspace(workspaceId) {
        return workspaces.includes(workspaceId) ? { workspaceId, name: workspaceId } : null;
      },
    }),
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
    randomState: () => "support-state",
  });
  return { handler, stateStore, connectionStore };
}

const cwrCalendar = {
  workspaceId: CWR,
  agentId: AGENT,
  provider: "google-calendar",
  connectionState: "connected",
  scopes: [],
  tokenVersion: 1,
  availableCalendars: [],
};

test("support mode: starting a calendar connection records the supported company, so the callback saves it there", async () => {
  const { handler, stateStore } = setup();
  const response = await handler(request("GET", "/oauth/google-calendar/start", { support: CWR, query: { agentId: AGENT } }));
  assert.equal(response.statusCode, 200);
  assert.equal((await stateStore.peek("support-state")).workspaceId, CWR);
});

test("support mode: the calendar card reads the supported company's connection, not the super admin's own", async () => {
  const { handler } = setup({ connections: [cwrCalendar] });
  const supporting = await handler(request("GET", "/calendars/connection", { support: CWR, query: { agentId: AGENT } }));
  assert.equal(supporting.statusCode, 200);
  assert.equal(JSON.parse(supporting.body)?.provider, "google-calendar");

  // Before the fix this is what support mode got: the super admin's own
  // workspace, with nothing connected.
  const own = await handler(request("GET", "/calendars/connection", { query: { agentId: AGENT } }));
  assert.equal(JSON.parse(own.body), null);
});

test("support mode: the header from anyone who isn't a super admin is ignored", async () => {
  const { handler, stateStore } = setup();
  const response = await handler(request("GET", "/oauth/google-calendar/start", {
    groups: ["company-admin"], support: CWR, query: { agentId: AGENT },
  }));
  assert.equal(response.statusCode, 200);
  assert.equal((await stateStore.peek("support-state")).workspaceId, OWN);
});

test("support mode: a company that doesn't exist is refused, never silently swapped for the super admin's own", async () => {
  for (const support of ["workspace-missing", "../workspace-cwr"]) {
    const { handler, stateStore } = setup();
    const response = await handler(request("GET", "/oauth/google-calendar/start", { support, query: { agentId: AGENT } }));
    assert.equal(response.statusCode, 404, support);
    assert.equal(JSON.parse(response.body).code, "support_company_not_found");
    assert.equal(await stateStore.peek("support-state"), null);
  }
});

test("support mode: refused when the workspace lookup isn't configured, rather than guessing", async () => {
  const handler = createHandler({
    getStateStore: async () => createInMemoryStateStore(),
    getMembershipStore: async () => createInMemoryMembershipStore([
      { userId: SUPER_ADMIN_SUB, workspaceId: OWN, status: "active" },
    ]),
    getWorkspaceStore: async () => null,
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
  });
  const response = await handler(request("GET", "/oauth/google-calendar/start", { support: CWR, query: { agentId: AGENT } }));
  assert.equal(response.statusCode, 404);
});

test("support mode: the super admin's own company works when the header names it", async () => {
  const { handler, stateStore } = setup();
  const response = await handler(request("GET", "/oauth/google-calendar/start", { support: OWN, query: { agentId: AGENT } }));
  assert.equal(response.statusCode, 200);
  assert.equal((await stateStore.peek("support-state")).workspaceId, OWN);
});

test("support mode: changes made while supporting a company are logged; reads are not", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const { handler } = setup({ connections: [cwrCalendar] });
  await handler(request("GET", "/calendars/connection", { support: CWR, query: { agentId: AGENT } }));
  assert.equal(info.mock.calls.filter((call) => call.arguments[0] === "support action").length, 0);

  await handler(request("DELETE", "/calendars/connection", { support: CWR, query: { agentId: AGENT } }));
  const logged = info.mock.calls.filter((call) => call.arguments[0] === "support action");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].arguments[1].workspaceId, CWR);
  assert.equal(logged[0].arguments[1].method, "DELETE");
});
