import assert from "node:assert/strict";
import test from "node:test";

import { legalAcceptanceStatus, parseAcceptBody } from "./legal.mjs";

async function loadBff() {
  return import("./index.mjs");
}

const TERMS = { version: "v1.0" };
const PRIVACY = { version: "v1.0" };

test("legalAcceptanceStatus - new user, nothing accepted", () => {
  const status = legalAcceptanceStatus({ activeTerms: TERMS, activePrivacy: PRIVACY, acceptedTerms: null, acceptedPrivacy: null });
  assert.equal(status.termsAccepted, false);
  assert.equal(status.privacyAccepted, false);
  assert.equal(status.requiresAcceptance, true);
  assert.equal(status.currentTermsVersion, "v1.0");
});

test("legalAcceptanceStatus - both current versions accepted", () => {
  const status = legalAcceptanceStatus({
    activeTerms: TERMS,
    activePrivacy: PRIVACY,
    acceptedTerms: { documentVersion: "v1.0", acceptedAt: "2026-09-04T00:00:00.000Z" },
    acceptedPrivacy: { documentVersion: "v1.0", acceptedAt: "2026-09-04T00:00:00.000Z" },
  });
  assert.equal(status.requiresAcceptance, false);
});

test("legalAcceptanceStatus - only terms updated -> only terms needs re-acceptance", () => {
  const status = legalAcceptanceStatus({
    activeTerms: { version: "v1.1" },
    activePrivacy: PRIVACY,
    acceptedTerms: { documentVersion: "v1.0" },
    acceptedPrivacy: { documentVersion: "v1.0" },
  });
  assert.equal(status.termsAccepted, false);
  assert.equal(status.privacyAccepted, true);
  assert.equal(status.requiresAcceptance, true);
});

test("legalAcceptanceStatus - only privacy updated -> only privacy needs re-acceptance", () => {
  const status = legalAcceptanceStatus({
    activeTerms: TERMS,
    activePrivacy: { version: "v1.1" },
    acceptedTerms: { documentVersion: "v1.0" },
    acceptedPrivacy: { documentVersion: "v1.0" },
  });
  assert.equal(status.termsAccepted, true);
  assert.equal(status.privacyAccepted, false);
  assert.equal(status.requiresAcceptance, true);
});

test("legalAcceptanceStatus - no active documents configured -> nothing required", () => {
  const status = legalAcceptanceStatus({ activeTerms: null, activePrivacy: null, acceptedTerms: null, acceptedPrivacy: null });
  assert.equal(status.requiresAcceptance, false);
});

test("parseAcceptBody validates version strings and requires at least one", () => {
  assert.deepEqual(parseAcceptBody({ termsVersion: "v1.0", privacyVersion: "v1.0" }), { terms: "v1.0", privacy: "v1.0" });
  assert.deepEqual(parseAcceptBody({ termsVersion: "v2" }), { terms: "v2" });
  assert.equal(parseAcceptBody({}), null);
  assert.equal(parseAcceptBody({ termsVersion: "1.0" }), null);
  assert.equal(parseAcceptBody(null), null);
});

// --- integration -----------------------------------------------------------

function legalStore() {
  const docs = new Map(); // `${type}#${version}` -> item
  const acceptances = new Map(); // `${userId}#${sk}` -> item
  return {
    docs,
    acceptances,
    async ensureWorkspace() {},
    async getMembership(userId) {
      return { userId, workspaceId: "workspace-tech", role: "company-admin", status: "active", email: "aj@tech.example", name: "AJ" };
    },
    async listProposals() { return []; },
    async getActiveLegalDocument(documentType) {
      return docs.get(`${documentType}#ACTIVE`) ?? null;
    },
    async putLegalDocumentVersion(documentType, doc) {
      docs.set(`${documentType}#${doc.version}`, { documentType, ...doc });
      docs.set(`${documentType}#ACTIVE`, { documentType, ...doc, version: doc.version });
    },
    async getLatestLegalAcceptance(userId, documentType) {
      return acceptances.get(`${userId}#LATEST#${documentType}`) ?? null;
    },
    async recordLegalAcceptance(record) {
      acceptances.set(`${record.userId}#HISTORY#${record.documentType}#${record.acceptedAt}`, record);
      acceptances.set(`${record.userId}#LATEST#${record.documentType}`, {
        documentVersion: record.documentVersion,
        acceptedAt: record.acceptedAt,
      });
    },
  };
}

function authed(method, path, body) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { sub: "user-aj", "cognito:groups": "company-admin" } } },
      http: { method, path, sourceIp: "203.0.113.7" },
    },
    headers: { "user-agent": "Mozilla/5.0 (Test)" },
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test("GET /workspaces/me/legal seeds v1.0 and reports acceptance required for a new user", async () => {
  const store = legalStore();
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  const res = await handler(authed("GET", "/workspaces/me/legal"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.requiresAcceptance, true);
  assert.equal(body.currentTermsVersion, "v1.0");
  assert.equal(body.currentPrivacyVersion, "v1.0");
  assert.ok(body.documents.termsAndConditions.content.includes("PLACEHOLDER"));
  assert.ok(body.documents.privacyPolicy.title.includes("Privacy Policy"));
});

test("the gate blocks every other authenticated call until both policies are accepted", async () => {
  const store = legalStore();
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });

  // Seed via the legal endpoint first.
  await handler(authed("GET", "/workspaces/me/legal"));

  const blocked = await handler(authed("GET", "/workspaces/me/proposals"));
  assert.equal(blocked.statusCode, 403);
  assert.equal(JSON.parse(blocked.body).error, "policy_acceptance_required");

  // Accept only Terms -> still blocked on Privacy.
  const partial = await handler(authed("POST", "/workspaces/me/legal/accept", { termsVersion: "v1.0" }));
  assert.equal(partial.statusCode, 200);
  assert.equal(JSON.parse(partial.body).requiresAcceptance, true);
  assert.equal((await handler(authed("GET", "/workspaces/me/proposals"))).statusCode, 403);

  // Accept Privacy too -> gate opens.
  const done = await handler(authed("POST", "/workspaces/me/legal/accept", { privacyVersion: "v1.0" }));
  assert.equal(JSON.parse(done.body).requiresAcceptance, false);
  assert.equal((await handler(authed("GET", "/workspaces/me/proposals"))).statusCode, 200);

  // Audit trail: an immutable HISTORY row per document, with IP + user agent.
  const history = [...store.acceptances.entries()].filter(([key]) => key.includes("HISTORY#"));
  assert.equal(history.length, 2);
  assert.equal(history[0][1].ipAddress, "203.0.113.7");
  assert.equal(history[0][1].userAgent, "Mozilla/5.0 (Test)");
  assert.equal(history[0][1].workspaceId, "workspace-tech");
});

test("accepting a superseded version is rejected", async () => {
  const store = legalStore();
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  await handler(authed("GET", "/workspaces/me/legal"));

  // Publish v1.1 of the Terms.
  const publish = await handler({
    ...authed("POST", "/platform/legal", { documentType: "TERMS_AND_CONDITIONS", version: "v1.1", title: "T&C", content: "New terms." }),
    requestContext: { authorizer: { jwt: { claims: { sub: "user-aj", "cognito:groups": "super-admin" } } }, http: { method: "POST", path: "/platform/legal" } },
  });
  assert.equal(publish.statusCode, 201);

  const stale = await handler(authed("POST", "/workspaces/me/legal/accept", { termsVersion: "v1.0" }));
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).error, "version_mismatch");
});

test("the gate is inert for a store that has no legal tables", async () => {
  const store = {
    async ensureWorkspace() {},
    async getMembership(userId) {
      return { userId, workspaceId: "w", role: "company-admin", status: "active" };
    },
    async listProposals() { return []; },
  };
  const { createHandler } = await loadBff();
  const handler = createHandler({ getStore: async () => store });
  const res = await handler(authed("GET", "/workspaces/me/proposals"));
  assert.equal(res.statusCode, 200);
});
