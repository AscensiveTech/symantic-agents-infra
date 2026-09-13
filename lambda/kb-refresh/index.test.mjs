import assert from "node:assert/strict";
import test from "node:test";

import { createHandler, isDue } from "./index.mjs";

test("isDue respects the configured 1/7/30-day interval, not Retell's fixed daily cadence", () => {
  const now = Date.parse("2026-09-13T10:00:00Z");
  assert.equal(isDue({ refreshIntervalDays: null }, now), false, "off means never due");
  assert.equal(
    isDue({ refreshIntervalDays: 1, lastRefreshedAt: "2026-09-12T09:00:00Z" }, now),
    true,
    "just over a day since last refresh",
  );
  assert.equal(
    isDue({ refreshIntervalDays: 7, lastRefreshedAt: "2026-09-12T09:00:00Z" }, now),
    false,
    "one day in, well within a 7-day interval",
  );
  assert.equal(
    isDue({ refreshIntervalDays: 30, lastRefreshedAt: "2026-08-01T09:00:00Z" }, now),
    true,
    "well past a 30-day interval",
  );
  assert.equal(isDue({ refreshIntervalDays: 1 }, now), true, "no lastRefreshedAt yet is treated as due");
});

test("handler refreshes only due URL sources, updates the record, and resyncs referencing agents", async () => {
  const dueItem = {
    workspaceId: "ws-1",
    knowledgeBaseId: "kb-due",
    kind: "url",
    name: "FAQ page",
    sourceLabel: "https://example.com/faq",
    retellKnowledgeBaseId: "retell-kb-old",
    refreshIntervalDays: 1,
    lastRefreshedAt: "2026-09-11T00:00:00Z",
  };
  const notDueItem = {
    workspaceId: "ws-1",
    knowledgeBaseId: "kb-not-due",
    kind: "url",
    name: "Pricing page",
    sourceLabel: "https://example.com/pricing",
    retellKnowledgeBaseId: "retell-kb-pricing",
    refreshIntervalDays: 30,
    lastRefreshedAt: "2026-09-12T00:00:00Z",
  };
  const agent = {
    id: "agent-1",
    status: "active",
    configuration: { knowledgeBaseIds: ["kb-due"] },
  };

  const updateCalls = [];
  const deleteCalls = [];
  const createCalls = [];
  const syncCalls = [];

  const store = {
    listWorkspaces: async () => [{ workspaceId: "ws-1" }],
    listKnowledgeBases: async () => [dueItem, notDueItem],
    updateKnowledgeBase: async (workspaceId, knowledgeBaseId, patch) => {
      updateCalls.push({ workspaceId, knowledgeBaseId, patch });
    },
    listAgents: async () => [agent],
    getProfile: async () => ({ businessName: "Acme" }),
  };
  const providers = {
    retell: {
      createKnowledgeBase: async (args) => {
        createCalls.push(args);
        return { knowledgeBaseId: "retell-kb-new" };
      },
      deleteKnowledgeBase: async (id) => {
        deleteCalls.push(id);
      },
    },
  };

  const handle = createHandler({
    getStore: async () => store,
    getProviders: async () => providers,
    getKnowledgeSigner: async () => ({}),
    syncReceptionistRuntime: async (args) => {
      syncCalls.push(args);
      return { retellAgentId: "retell-agent-1", phoneNumber: {} };
    },
    now: () => Date.parse("2026-09-13T10:00:00Z"),
  });

  const result = await handle();

  assert.equal(result.refreshed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(createCalls, [{ name: "FAQ page", urls: ["https://example.com/faq"], enableAutoRefresh: false }]);
  assert.deepEqual(deleteCalls, ["retell-kb-old"]);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].knowledgeBaseId, "kb-due");
  assert.equal(updateCalls[0].patch.retellKnowledgeBaseId, "retell-kb-new");
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].agentId, "agent-1");
});
