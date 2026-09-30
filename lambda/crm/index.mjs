import { NO_CRM_CONTEXT } from "./context.mjs";
import { getRuntime } from "./runtime.mjs";

/**
 * The CRM Lambda's two synchronous entry points:
 *  - API Gateway (HTTP API v2 events): connection settings, OAuth callback,
 *    Monday lifecycle webhook.
 *  - Direct invoke from the BFF during Retell's inbound-call webhook:
 *    { action: "lookup", workspaceId, agentId, callerNumber } -> caller context.
 *  - Direct invoke from the BFF deleting an agent:
 *    { action: "disconnect-agent", workspaceId, agentId } -> { status }.
 *  - Async invoke from the BFF: { action: "sync-follow-up", workspaceId, callId }
 *    -> push an edited follow-up to the Monday row.
 *  - EventBridge schedule: { action: "refresh-tokens" } -> token keeper.
 * (The SQS consumer is worker.mjs, deployed as its own function.)
 */
export function createHandler({ getRuntime: loadRuntime = getRuntime } = {}) {
  return async function handle(event) {
    if (event?.requestContext?.http) {
      const runtime = await loadRuntime();
      return runtime.api(event);
    }
    if (event?.action === "lookup") {
      try {
        const runtime = await loadRuntime();
        return await runtime.lookup({
          workspaceId: event.workspaceId,
          agentId: event.agentId,
          callerNumber: event.callerNumber,
        });
      } catch (error) {
        console.error("CRM lookup could not start", { name: error?.name });
        return { status: "error", context: NO_CRM_CONTEXT };
      }
    }
    if (event?.action === "disconnect-agent") {
      const runtime = await loadRuntime();
      return runtime.disconnectAgent({ workspaceId: event.workspaceId, agentId: event.agentId });
    }
    if (event?.action === "sync-follow-up") {
      const runtime = await loadRuntime();
      return runtime.syncFollowUp({ workspaceId: event.workspaceId, callId: event.callId });
    }
    if (event?.action === "refresh-tokens") {
      const runtime = await loadRuntime();
      return runtime.refreshTokens();
    }
    return { statusCode: 400, body: JSON.stringify({ message: "Unsupported event" }) };
  };
}

// Build the runtime (AWS SDK clients, config) during init, so a provisioned
// instance serves its first call-time lookup without paying for it. A failure
// here is not fatal: getRuntime() retries on the first request.
if (process.env.AWS_LAMBDA_FUNCTION_NAME) await getRuntime().catch(() => undefined);

export const handler = createHandler();
