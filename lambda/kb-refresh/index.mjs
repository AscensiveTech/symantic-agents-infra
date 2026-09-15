// Scheduled Lambda (EventBridge, daily at 10:00 UTC) that implements our own
// 1/7/30-day knowledge-base URL refresh cadence on top of Retell's own
// enable_auto_refresh, which is only a fixed-daily on/off toggle with no
// interval option (confirmed against Retell's docs). For each URL-kind
// knowledge-base item whose configured interval has elapsed since it was
// last refreshed, this deletes and recreates the Retell knowledge base
// (Retell has no endpoint to force a re-scrape of an existing source), then
// re-syncs every agent that references it so their Retell LLM picks up the
// new knowledge_base_id.
import {
  getDefaultStore,
  getDefaultProviders,
  getDefaultKnowledgeSigner,
  syncReceptionistRuntime as defaultSyncReceptionistRuntime,
} from "../bff/index.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isDue(item, now) {
  const intervalDays = [1, 7, 30].includes(item.refreshIntervalDays) ? item.refreshIntervalDays : null;
  if (!intervalDays) return false;
  const lastRefreshedAt = Date.parse(item.lastRefreshedAt ?? "");
  if (Number.isNaN(lastRefreshedAt)) return true;
  return now - lastRefreshedAt >= intervalDays * DAY_MS;
}

export function createHandler({
  getStore = getDefaultStore,
  getProviders = getDefaultProviders,
  getKnowledgeSigner = getDefaultKnowledgeSigner,
  syncReceptionistRuntime = defaultSyncReceptionistRuntime,
  toolBaseUrl = process.env.PUBLIC_API_BASE_URL,
  now = () => Date.now(),
} = {}) {
  return async function handle() {
    const store = await getStore();
    const providers = await getProviders();
    const nowMs = now();

    const workspaces = await store.listWorkspaces();
    let refreshed = 0;
    let failed = 0;

    for (const workspace of workspaces) {
      const workspaceId = workspace.workspaceId ?? workspace.id;
      if (!workspaceId) continue;
      let items;
      try {
        items = await store.listKnowledgeBases(workspaceId);
      } catch (error) {
        console.error(`Failed to list knowledge bases for ${workspaceId}`, error);
        continue;
      }
      const due = items.filter((item) => item.kind === "url" && item.sourceLabel && isDue(item, nowMs));
      if (!due.length) continue;

      let agents = null;
      for (const item of due) {
        try {
          const created = await providers.retell.createKnowledgeBase({
            name: item.name,
            urls: [item.sourceLabel],
            enableAutoRefresh: false,
          });
          try {
            await providers.retell.deleteKnowledgeBase(item.retellKnowledgeBaseId);
          } catch (error) {
            console.error(`Failed to delete stale Retell KB ${item.retellKnowledgeBaseId}`, error);
          }
          await store.updateKnowledgeBase(workspaceId, item.knowledgeBaseId, {
            retellKnowledgeBaseId: created.knowledgeBaseId,
            lastRefreshedAt: new Date(nowMs).toISOString(),
            lastRefreshAttemptAt: new Date(nowMs).toISOString(),
            refreshStatus: "ok",
            lastRefreshError: null,
            updatedAt: new Date(nowMs).toISOString(),
          });
          refreshed += 1;

          agents ??= await store.listAgents(workspaceId).catch(() => []);
          const referencing = agents.filter((agent) =>
            Array.isArray(agent?.configuration?.knowledgeBaseIds) &&
            agent.configuration.knowledgeBaseIds.includes(item.knowledgeBaseId));
          for (const agent of referencing) {
            try {
              const profile = await store.getProfile(workspaceId);
              if (!profile) continue;
              await syncReceptionistRuntime({
                workspaceId,
                agentId: agent.id,
                agent,
                profile,
                store,
                providers,
                getKnowledgeSigner,
                toolBaseUrl,
                phoneStatus: agent.status === "active" ? "active" : "draft",
              });
            } catch (error) {
              console.error(`Failed to resync agent ${agent.id} after KB refresh`, error);
            }
          }
        } catch (error) {
          failed += 1;
          console.error(`Failed to refresh knowledge base ${item.knowledgeBaseId} for ${workspaceId}`, error);
          await store.updateKnowledgeBase(workspaceId, item.knowledgeBaseId, {
            refreshStatus: "failed",
            lastRefreshError: error instanceof Error ? error.message : "Unable to refresh this website",
            lastRefreshAttemptAt: new Date(nowMs).toISOString(),
          }).catch(() => {});
        }
      }
    }

    return { refreshed, failed };
  };
}

export const handler = createHandler();
