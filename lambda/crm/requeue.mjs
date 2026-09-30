import { CRM_ERROR } from "./errors.mjs";

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

export function createRequeuer({ store, enqueue, metrics, now = Date.now, provider = "monday" }) {
  return async function requeueFailed(workspaceId, { onlyCodes, limit = MAX_REQUEUE } = {}) {
    const since = new Date(Number(now()) - RETRY_WINDOW_DAYS * 86_400_000).toISOString();
    const failed = (await store.listFailedCalls(workspaceId, since))
      .filter((call) => !onlyCodes || onlyCodes.has(call.crmLastErrorCode))
      .slice(0, limit);
    let requeued = 0;
    for (const call of failed) {
      if (await store.markCallQueued(workspaceId, call.callId, provider)) {
        await enqueue({ workspaceId, callId: call.callId, provider });
        requeued += 1;
      }
    }
    if (requeued) metrics?.emit("SyncRequeued", requeued, { Provider: provider });
    return requeued;
  };
}
