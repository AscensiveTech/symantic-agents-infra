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
export function createTokenKeeper({ store, sessions, metrics, now = Date.now, log = console }) {
  return async function refreshTokens() {
    const connected = await store.listConnected();
    let refreshed = 0;
    let fresh = 0;
    let failed = 0;
    for (const { workspaceId, provider } of connected) {
      const connection = await store.getConnection(workspaceId, provider);
      if (connection?.connectionState !== "connected") continue;
      if (Number(connection.accessTokenExpiresAt) - Number(now()) > REFRESH_AHEAD_MS) {
        fresh += 1;
        continue;
      }
      try {
        await sessions.accessTokenFor(connection, { minValidityMs: REFRESH_AHEAD_MS });
        refreshed += 1;
      } catch (error) {
        failed += 1;
        log.warn?.("CRM token keeper could not refresh", { workspaceId, provider, ...describeError(error) });
      }
    }
    metrics?.emit("KeeperRefreshed", refreshed, { Provider: "monday" });
    if (failed) metrics?.emit("KeeperFailed", failed, { Provider: "monday" });
    return { connected: connected.length, refreshed, fresh, failed };
  };
}
