import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, KEY_A } from "./test-support/harness.mjs";

// Support mode: a super administrator (here sub-admin-b, whose own workspace
// is ws-b) working inside another company (ws-a) through Manage Company
// Accounts > Support. The CRM API must act on that company, exactly like the
// BFF, or every Monday request for the company's agent fails with "That agent
// no longer exists."
const SUPER_ADMIN = { sub: "sub-admin-b", groups: ["super-admin"] };
const SUPPORTING_A = { "x-support-workspace": "ws-a" };

test("support mode: a super admin sees the supported company's agent instead of 'agent no longer exists'", async () => {
  const h = createHarness();
  const withoutSupport = await h.api("GET", "/crm/connection", { ...SUPER_ADMIN, agent: "agent-a" });
  assert.equal(withoutSupport.statusCode, 404);
  assert.equal(JSON.parse(withoutSupport.body).error, "agent_not_found");

  const supporting = await h.api("GET", "/crm/connection", { ...SUPER_ADMIN, agent: "agent-a", headers: SUPPORTING_A });
  assert.equal(supporting.statusCode, 200);
});

test("support mode: connecting Monday saves the connection to the supported company, not the super admin's own", async () => {
  const h = createHarness();
  const start = await h.api("POST", "/crm/monday/start", {
    ...SUPER_ADMIN, agent: "agent-a", headers: SUPPORTING_A, body: { returnTo: "/integrations" },
  });
  assert.equal(start.statusCode, 200);
  const url = new URL(JSON.parse(start.body).authorizeUrl);
  const code = h.monday.issueCode({
    redirectUri: url.searchParams.get("redirect_uri"),
    challenge: url.searchParams.get("code_challenge"),
  });
  const callback = await h.api("GET", "/crm/oauth/monday/callback", {
    query: { code, state: url.searchParams.get("state") },
  });
  assert.equal(callback.statusCode, 302);

  const saved = await h.store.getConnection("ws-a", KEY_A);
  assert.equal(saved?.connectionState, "connected");
  assert.equal(saved.agentId, "agent-a");
  assert.equal(await h.store.getConnection("ws-b", KEY_A), null);

  // And the card reads it back in support mode.
  const card = await h.api("GET", "/crm/connection", { ...SUPER_ADMIN, agent: "agent-a", headers: SUPPORTING_A });
  assert.equal(JSON.parse(card.body).connectionState, "connected");
});

test("support mode: the header from anyone who isn't a super admin is ignored", async () => {
  const h = createHarness();
  const companyAdmin = await h.api("GET", "/crm/connection", {
    sub: "sub-admin-b", groups: ["company-admin"], agent: "agent-a", headers: SUPPORTING_A,
  });
  assert.equal(companyAdmin.statusCode, 404);
  assert.equal(JSON.parse(companyAdmin.body).error, "agent_not_found");

  // Their own company still works as usual.
  const own = await h.api("GET", "/crm/connection", { sub: "sub-admin-b", groups: ["company-admin"], agent: "agent-b", headers: SUPPORTING_A });
  assert.equal(own.statusCode, 200);
});

test("support mode: a company that doesn't exist is refused, never silently swapped for the super admin's own", async () => {
  const h = createHarness();
  for (const workspaceId of ["ws-missing", "../ws-a", ""]) {
    const response = await h.api("GET", "/crm/connection", {
      ...SUPER_ADMIN, agent: "agent-b", headers: { "x-support-workspace": workspaceId },
    });
    if (workspaceId === "") {
      // No header value at all is ordinary, non-support use.
      assert.equal(response.statusCode, 200);
      continue;
    }
    assert.equal(response.statusCode, 404, workspaceId);
    assert.equal(JSON.parse(response.body).error, "support_company_not_found");
  }
});

test("support mode: the super admin's own company works when the header names it", async () => {
  const h = createHarness();
  const response = await h.api("GET", "/crm/connection", {
    ...SUPER_ADMIN, agent: "agent-b", headers: { "x-support-workspace": "ws-b" },
  });
  assert.equal(response.statusCode, 200);
});

test("support mode: changes made while supporting a company are logged; reads are not", async () => {
  const h = createHarness();
  await h.api("GET", "/crm/connection", { ...SUPER_ADMIN, agent: "agent-a", headers: SUPPORTING_A });
  assert.equal(h.logs.filter((entry) => entry.message === "support action").length, 0);

  await h.api("POST", "/crm/monday/start", {
    ...SUPER_ADMIN, agent: "agent-a", headers: SUPPORTING_A, body: { returnTo: "/integrations" },
  });
  const logged = h.logs.filter((entry) => entry.message === "support action");
  assert.equal(logged.length, 1);
  assert.deepEqual(
    { actor: logged[0].fields.actorUserId, workspace: logged[0].fields.workspaceId, method: logged[0].fields.method },
    { actor: "sub-admin-b", workspace: "ws-a", method: "POST" },
  );
});
