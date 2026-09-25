import { describeError } from "./errors.mjs";

// Refresh tokens this far ahead of expiry. With the keeper running every 10
// minutes, every connected account always holds an access token with at
// least 15 minutes left, so the call-time lookup never pays for a refresh
// (an auth round trip, two KMS encryptions and a DynamoDB compare-and-swap).
export const REFRESH_AHEAD_MS = 25 * 60 * 1000;

/**
 * Scheduled token keeper. Keeps Monday access tokens fresh for every
 * connected workspace, and - as a side effect - finds revoked grants before
 * the next call does (the session marks them reauth_required).
 */
export function createTokenKeeper({
  store,
  sessions,
  metrics,
  now = Date.now,
  log = console,
  concurrency = 5,
  // The Lambda has 15 s; stop starting new refreshes after this. Anything
  // skipped still has 15+ minutes of validity and is refreshed next run.
  budgetMs = 10_000,
}) {
  return async function refreshTokens() {
    const started = Number(now());
    const connected = await store.listConnected();
    const counts = { connected: connected.length, refreshed: 0, fresh: 0, failed: 0, deferred: 0 };
    const queue = [...connected];

    // One tenant's failure (DynamoDB, Monday, KMS) never stops the others.
    async function refreshOne({ workspaceId, provider }) {
      try {
        const connection = await store.getConnection(workspaceId, provider);
        if (connection?.connectionState !== "connected") return;
        if (Number(connection.accessTokenExpiresAt) - Number(now()) > REFRESH_AHEAD_MS) {
          counts.fresh += 1;
          return;
        }
        await sessions.accessTokenFor(connection, { minValidityMs: REFRESH_AHEAD_MS });
        counts.refreshed += 1;
      } catch (error) {
        counts.failed += 1;
        log.warn?.("CRM token keeper could not refresh", { workspaceId, provider, ...describeError(error) });
      }
    }

    async function lane() {
      while (queue.length) {
        if (Number(now()) - started > budgetMs) {
          counts.deferred += queue.length;
          queue.length = 0;
          return;
        }
        await refreshOne(queue.shift());
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    metrics?.emit("KeeperRefreshed", counts.refreshed, { Provider: "monday" });
    if (counts.failed) metrics?.emit("KeeperFailed", counts.failed, { Provider: "monday" });
    if (counts.deferred) log.warn?.("CRM token keeper ran out of time; the rest refresh next run", { deferred: counts.deferred });
    return counts;
  };
}
