import { createHash } from "node:crypto";

export function stableId(prefix, workspaceId, idempotencyKey) {
  const digest = stableDigest(workspaceId, idempotencyKey);
  return `${prefix}-${digest.slice(0, 24)}`;
}

export function providerIdempotencyIds(workspaceId, idempotencyKey) {
  const digest = stableDigest(workspaceId, idempotencyKey);
  return {
    googleEventId: `s${digest.slice(0, 31)}`,
    microsoftTransactionId: [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `a${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join("-"),
  };
}

export function isConditionalFailure(error) {
  return error?.name === "ConditionalCheckFailedException";
}

// Two different calls can both pass a "check availability, then book" race
// if they land close enough together - the check-then-write pattern alone
// doesn't stop that, and the calendar providers themselves don't reject an
// overlapping event (only a literal retry of the exact same event id).
// This gives every (agent, time range) pair a short-lived, deterministic
// lock id so a second concurrent attempt for the same slot can be turned
// away immediately instead of racing through to the provider.
export function slotLockId(agentId, startTimeUtc, endTimeUtc) {
  const digest = createHash("sha256")
    .update(`${agentId ?? ""}\0${startTimeUtc}\0${endTimeUtc}`)
    .digest("hex");
  return `lock-${digest.slice(0, 24)}`;
}

export function appointmentResponse(record) {
  return {
    ok: true,
    appointmentId: record.appointmentId,
    status: record.status,
    startTimeUtc: record.startTimeUtc,
    endTimeUtc: record.endTimeUtc,
    timezone: record.timezone,
    message: record.status === "cancelled"
      ? "The appointment is cancelled."
      : record.status === "rescheduled"
      ? "The appointment is rescheduled."
      : "The appointment is confirmed.",
  };
}

export function leadResponse(record) {
  return {
    ok: true,
    leadId: record.leadId,
    status: record.status,
    message: "We will notify the office.",
  };
}

export function messageResponse(record) {
  return {
    ok: true,
    messageId: record.messageId,
    status: record.status,
    message: "We will notify the office.",
  };
}

function stableDigest(workspaceId, idempotencyKey) {
  return createHash("sha256")
    .update(`${workspaceId}\0${idempotencyKey}`)
    .digest("hex");
}
