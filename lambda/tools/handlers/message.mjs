import { requireString } from "./errors.mjs";
import {
  isConditionalFailure,
  messageResponse,
  stableId,
} from "./records.mjs";

export async function handleMessageTake(input, {
  store,
  notifyOffice,
  now,
}) {
  const text = requireString(input.message, "message");
  const messageId = stableId(
    "msg",
    input.workspaceId,
    input.idempotencyKey,
  );
  const existing = await store.getMessage(input.workspaceId, messageId);
  if (existing) return messageResponse(existing);

  const timestamp = new Date(now()).toISOString();
  const message = {
    workspaceId: input.workspaceId,
    messageId,
    callId: input.callId,
    agentId: stringOrUndefined(input.agentId),
    idempotencyKey: input.idempotencyKey,
    name: stringOrUndefined(input.name),
    phone: stringOrUndefined(input.phone),
    email: stringOrUndefined(input.email),
    message: text,
    urgency: stringOrUndefined(input.urgency),
    status: "received",
    notifyStatus: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await store.putMessage(message);
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    const original = await store.getMessage(input.workspaceId, messageId);
    if (!original) throw error;
    return messageResponse(original);
  }
  await notifyOffice("message", message);
  return messageResponse(message);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
