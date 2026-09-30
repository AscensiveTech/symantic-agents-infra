import { describeError } from "./errors.mjs";
import { isConnectionPaused, isConnectionUsable } from "./provider.mjs";
import { OUTAGE_ERROR_CODES } from "./requeue.mjs";

// Refresh tokens this far ahead of expiry. With the keeper running every 10
// minutes, every connected account always holds an access token with at
// least 15 minutes left, so the call-time lookup never pays for a refresh
// (an auth round trip, two KMS encryptions and a DynamoDB compare-and-swap).
export const REFRESH_AHEAD_MS = 25 * 60 * 1000;
// Calls that ran out of retries while Monday was down are replayed at most
// this often, for up to a week after the last failure.
export const AUTO_REQUEUE_EVERY_MS = 30 * 60 * 1000;
const AUTO_REQUEUE_WINDOW_MS = 7 * 86_400_000;

/**
 * Scheduled token keeper. Keeps Monday access tokens fresh for every
 * connected workspace, and - as a side effect - finds revoked grants before
 * the next call does (the session marks them reauth_required).
 */
export function createTokenKeeper({
  store,
  sessions,
  requeueFailed,
  remindReauth,
  checkCallsBoard,
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
    const listed = await store.listConnected();
    const connected = listed.filter((row) => row.connectionState !== "reauth_required");
    const expired = listed.filter((row) => row.connectionState === "reauth_required");
    const counts = { connected: connected.length, refreshed: 0, fresh: 0, failed: 0, deferred: 0, requeued: 0 };
    const queue = [...connected];

    // One tenant's failure (DynamoDB, Monday, KMS) never stops the others.
    async function refreshOne({ workspaceId, provider }) {
      try {
        const connection = await store.getConnection(workspaceId, provider);
        if (connection?.connectionState !== "connected") return;
        // Board check first, so a deletion found now is emailed in this run.
        await checkCallsBoard?.(connection).catch((error) => {
          log.warn?.("Calls board check failed", { workspaceId, provider, ...describeError(error) });
        });
        await remindReauth?.(connection);
        if (Number(connection.accessTokenExpiresAt) - Number(now()) > REFRESH_AHEAD_MS) {
          counts.fresh += 1;
        } else {
          await sessions.accessTokenFor(connection, { minValidityMs: REFRESH_AHEAD_MS });
          counts.refreshed += 1;
        }
        await replayOutageFailures(connection);
      } catch (error) {
        counts.failed += 1;
        log.warn?.("CRM token keeper could not refresh", { workspaceId, provider, ...describeError(error) });
      }
    }

    // A Monday outage longer than the worker's retry budget leaves calls
    // failed; replay them once Monday may be back, without an admin click.
    async function replayOutageFailures(connection) {
      if (!requeueFailed || !isConnectionUsable(connection) || isConnectionPaused(connection, Number(now()))) return;
      const lastError = Date.parse(connection.lastErrorAt ?? "");
      if (!Number.isFinite(lastError) || Number(now()) - lastError > AUTO_REQUEUE_WINDOW_MS) return;
      if (Number(now()) - Number(connection.autoRequeuedAt ?? 0) < AUTO_REQUEUE_EVERY_MS) return;
      await store.markAutoRequeued(connection.workspaceId, connection.provider);
      counts.requeued += await requeueFailed(connection.workspaceId, connection.provider, { onlyCodes: OUTAGE_ERROR_CODES, limit: 100 });
    }

    // One worker lane: refreshes connections until the queue is empty or the
    // time budget runs out. Leftovers are counted and handled on the next
    // run.
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

    // Grants that already ended: one "reconnect to resume logging" email each.
    for (const { workspaceId, provider } of expired) {
      try {
        const connection = await store.getConnection(workspaceId, provider);
        if (connection?.connectionState === "reauth_required") await remindReauth?.(connection);
      } catch (error) {
        log.warn?.("CRM reconnect reminder failed", { workspaceId, provider, ...describeError(error) });
      }
    }
    metrics?.emit("KeeperRefreshed", counts.refreshed, { Provider: "monday" });
    if (counts.failed) metrics?.emit("KeeperFailed", counts.failed, { Provider: "monday" });
    if (counts.requeued) metrics?.emit("KeeperRequeued", counts.requeued, { Provider: "monday" });
    if (counts.deferred) log.warn?.("CRM token keeper ran out of time; the rest refresh next run", { deferred: counts.deferred });
    return counts;
  };
}
