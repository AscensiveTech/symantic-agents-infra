import assert from "node:assert/strict";
import test from "node:test";

import { createHandler, isDueToday, triggerDayOfMonth } from "./index.mjs";

test("triggerDayOfMonth is 15 days after the account's creation day, clamped into 1-28", () => {
  assert.equal(triggerDayOfMonth("2026-01-01T00:00:00Z"), 16);
  assert.equal(triggerDayOfMonth("2026-01-20T00:00:00Z"), 7, "wraps within the 1-28 range");
  assert.equal(triggerDayOfMonth("2026-01-31T00:00:00Z"), 18, "the 31st is clamped like any other day");
  assert.equal(triggerDayOfMonth("not-a-date"), 1);
});

test("isDueToday only fires on the workspace's own trigger day", () => {
  const workspace = { createdAt: "2026-01-01T00:00:00Z" }; // trigger day 16
  assert.equal(isDueToday(workspace, Date.parse("2026-09-16T09:00:00Z")), true);
  assert.equal(isDueToday(workspace, Date.parse("2026-09-15T09:00:00Z")), false);
  assert.equal(isDueToday(workspace, Date.parse("2026-09-17T09:00:00Z")), false);
  assert.equal(isDueToday({}, Date.now()), false, "no createdAt is never due");
});

function storeWith({ workspaces, profiles = {}, digestsByWorkspace = {} }) {
  const created = [];
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async (workspaceId) => workspaces.find((w) => w.workspaceId === workspaceId) ?? null,
    getProfile: async (workspaceId) => profiles[workspaceId] ?? { timezone: "America/New_York" },
    listCalls: async () => [
      { callId: "c1", agentId: "agent-1", startedAt: new Date().toISOString(), callSummary: "Asked about pricing." },
    ],
    listMostAskedDigests: async (workspaceId) => digestsByWorkspace[workspaceId] ?? [],
    createMostAskedDigest: async (record) => {
      created.push(record);
      return record;
    },
    created,
  };
}

const providers = {
  anthropic: {
    async summarizeMostAskedQuestions() {
      return {
        questions: [{ question: "Q", count: 1, exampleQuote: "q", suggestedKnowledgeBaseAddition: "add" }],
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 10, outputTokens: 5 },
        costCents: 0.05,
      };
    },
  },
};

test("handler auto-refreshes an entitled workspace on its trigger day when no digest exists yet this cycle", async () => {
  const now = Date.parse("2026-09-16T09:00:00Z"); // trigger day 16
  const store = storeWith({
    workspaces: [{ workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true }],
  });
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 1, skipped: 0, failed: 0 });
  assert.equal(store.created.length, 1);
  assert.equal(store.created[0].workspaceId, "ws-1");
  assert.equal(store.created[0].agentId, "all");
});

test("handler skips a workspace not entitled to the premium feature", async () => {
  const now = Date.parse("2026-09-16T09:00:00Z");
  const store = storeWith({
    workspaces: [{ workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: false }],
  });
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 0, skipped: 0, failed: 0 });
  assert.equal(store.created.length, 0);
});

test("handler skips a workspace not due today", async () => {
  const now = Date.parse("2026-09-15T09:00:00Z"); // one day before trigger day 16
  const store = storeWith({
    workspaces: [{ workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true }],
  });
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 0, skipped: 0, failed: 0 });
  assert.equal(store.created.length, 0);
});

test("handler skips a workspace that already has a digest for the current cycle - manual or a prior auto-run", async () => {
  const now = Date.parse("2026-09-16T09:00:00Z"); // trigger day 16
  const store = storeWith({
    workspaces: [{ workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true }],
    digestsByWorkspace: {
      "ws-1": [{ digestId: "d1", generatedAt: "2026-09-02T00:00:00Z", agentId: "all", questions: [] }],
    },
  });
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 0, skipped: 1, failed: 0 });
  assert.equal(store.created.length, 0);
});

test("handler still generates for a workspace whose last digest was from a previous cycle", async () => {
  const now = Date.parse("2026-09-16T09:00:00Z"); // trigger day 16
  const store = storeWith({
    workspaces: [{ workspaceId: "ws-1", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true }],
    digestsByWorkspace: {
      "ws-1": [{ digestId: "d1", generatedAt: "2026-08-16T00:00:00Z", agentId: "all", questions: [] }],
    },
  });
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 1, skipped: 0, failed: 0 });
  assert.equal(store.created.length, 1);
});

test("handler counts a per-workspace failure without stopping the rest of the run", async () => {
  const now = Date.parse("2026-09-16T09:00:00Z"); // trigger day 16 for both
  const store = storeWith({
    workspaces: [
      { workspaceId: "ws-broken", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true },
      { workspaceId: "ws-ok", createdAt: "2026-01-01T00:00:00Z", mostAskedQuestionsEnabled: true },
    ],
  });
  const originalGetProfile = store.getProfile;
  store.getProfile = async (workspaceId) => {
    if (workspaceId === "ws-broken") throw new Error("profile lookup failed");
    return originalGetProfile(workspaceId);
  };
  const handler = createHandler({ getStore: async () => store, getProviders: async () => providers, now: () => now });

  const result = await handler();
  assert.deepEqual(result, { refreshed: 1, skipped: 0, failed: 1 });
  assert.equal(store.created.length, 1);
  assert.equal(store.created[0].workspaceId, "ws-ok");
});
