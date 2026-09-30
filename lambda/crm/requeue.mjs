import { CRM_ERROR } from "./errors.mjs";
import { agentIdOf, providerIdOf } from "./provider.mjs";

const RETRY_WINDOW_DAYS = 7;
const MAX_REQUEUE = 500;

// Failures caused by Monday being down, slow or busy - safe to replay without
// anyone changing anything. Mapping, auth and data problems are not.
export const OUTAGE_ERROR_CODES = new Set([
  CRM_ERROR.TIMEOUT,
  CRM_ERROR.TRANSIENT,
  CRM_ERROR.RATE_LIMITED,
  CRM_ERROR.DAILY_LIMIT,
  CRM_ERROR.PROVIDER_ERROR,
  CRM_ERROR.CONFLICT,
  CRM_ERROR.LEASE_BUSY,
  "unexpected",
]);

// A failed call belongs to a connection when it was synced under that
// connection's key, or (older rows) under the bare provider for that agent.
function belongsTo(call, connectionKey) {
  if (call.crmProvider === connectionKey) return true;
  return call.crmProvider === providerIdOf(connectionKey) && call.agentId === agentIdOf(connectionKey);
}

export function createRequeuer({ store, enqueue, metrics, now = Date.now }) {
  return async function requeueFailed(workspaceId, connectionKey, { onlyCodes, limit = MAX_REQUEUE } = {}) {
    const since = new Date(Number(now()) - RETRY_WINDOW_DAYS * 86_400_000).toISOString();
    const failed = (await store.listFailedCalls(workspaceId, since))
      .filter((call) => belongsTo(call, connectionKey))
      .filter((call) => !onlyCodes || onlyCodes.has(call.crmLastErrorCode))
      .slice(0, limit);
    let requeued = 0;
    for (const call of failed) {
      if (await store.markCallQueued(workspaceId, call.callId, connectionKey)) {
        await enqueue({ workspaceId, callId: call.callId, provider: connectionKey });
        requeued += 1;
      }
    }
    if (requeued) metrics?.emit("SyncRequeued", requeued, { Provider: providerIdOf(connectionKey) });
    return requeued;
  };
}
