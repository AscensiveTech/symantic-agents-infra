import { NO_CRM_CONTEXT } from "./context.mjs";
import { getRuntime } from "./runtime.mjs";

/**
 * The CRM Lambda's two synchronous entry points:
 *  - API Gateway (HTTP API v2 events): connection settings, OAuth callback,
 *    Monday lifecycle webhook.
 *  - Direct invoke from the BFF during Retell's inbound-call webhook:
 *    { action: "lookup", workspaceId, callerNumber } -> caller context.
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
          callerNumber: event.callerNumber,
        });
      } catch (error) {
        console.error("CRM lookup could not start", { name: error?.name });
        return { status: "error", context: NO_CRM_CONTEXT };
      }
    }
    return { statusCode: 400, body: JSON.stringify({ message: "Unsupported event" }) };
  };
}

export const handler = createHandler();
