import { describeError } from "./errors.mjs";
import { getRuntime } from "./runtime.mjs";

// Must match maxReceiveCount on the queue's redrive policy (crm.tf): the
// attempt that sees this count is the last one before the DLQ.
export const MAX_ATTEMPTS = 8;
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60;

/** Exponential backoff with jitter, unless the error names its own wait. */
export function backoffSeconds(error, attempt, random = Math.random) {
  if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) {
    return Math.min(MAX_VISIBILITY_SECONDS, Math.ceil(error.retryAfterSeconds + random() * 5));
  }
  const base = Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.min(MAX_VISIBILITY_SECONDS, Math.ceil(base + random() * 10));
}

/**
 * SQS consumer for post-call CRM sync. Reports partial batch failures so one
 * slow tenant never holds up another's messages, and pushes each failed
 * message's visibility out by its backoff before handing it back to SQS.
 */
export function createWorker({
  sync,
  changeVisibility,
  metrics,
  now = Date.now,
  log = console,
  random = Math.random,
}) {
  return async function handle(event) {
    const batchItemFailures = [];
    for (const record of event?.Records ?? []) {
      const attempt = Number(record?.attributes?.ApproximateReceiveCount) || 1;
      const sentAt = Number(record?.attributes?.SentTimestamp);
      if (sentAt) metrics?.emit("QueueAge", Math.max(0, Number(now()) - sentAt), { Provider: "monday" });

      let message;
      try {
        message = JSON.parse(record.body);
      } catch {
        message = null;
      }
      if (
        typeof message?.workspaceId !== "string" || !message.workspaceId ||
        typeof message?.callId !== "string" || !message.callId
      ) {
        // Retrying a malformed message can't fix it; drop it loudly.
        log.error?.("Dropping malformed CRM sync message", { messageId: record?.messageId });
        metrics?.count("SyncFailed", { Provider: "monday", Outcome: "malformed_message" });
        continue;
      }

      try {
        await sync.syncCall({
          workspaceId: message.workspaceId,
          callId: message.callId,
          attempt,
          finalAttempt: attempt >= MAX_ATTEMPTS,
        });
      } catch (error) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        if (attempt >= MAX_ATTEMPTS) {
          metrics?.count("DeadLettered", { Provider: "monday", Outcome: describeError(error).code });
          log.error?.("CRM sync exhausted retries; message goes to the DLQ", {
            workspaceId: message.workspaceId,
            callId: message.callId,
            ...describeError(error),
          });
          continue;
        }
        const delay = backoffSeconds(error, attempt, random);
        try {
          await changeVisibility(record.receiptHandle, delay);
        } catch (visibilityError) {
          log.warn?.("Could not set CRM retry backoff; SQS default applies", {
            name: visibilityError?.name,
          });
        }
      }
    }
    return { batchItemFailures };
  };
}

let workerPromise;

export async function handler(event) {
  workerPromise ??= getRuntime().then((runtime) => createWorker({
    sync: runtime.sync,
    changeVisibility: runtime.changeVisibility,
    metrics: runtime.metrics,
  }));
  return (await workerPromise)(event);
}
