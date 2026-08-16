import { ToolRequestError } from "./errors.mjs";
import {
  isConditionalFailure,
  leadResponse,
  stableId,
} from "./records.mjs";

export async function handleLeadCapture(input, {
  store,
  notifyOffice,
  now,
}) {
  const contact = {
    name: stringOrUndefined(input.name),
    phone: stringOrUndefined(input.phone),
    email: stringOrUndefined(input.email),
  };
  if (!contact.name || (!contact.phone && !contact.email)) {
    throw new ToolRequestError(
      "Lead name and either phone or email are required",
    );
  }
  const leadId = stableId("lead", input.workspaceId, input.idempotencyKey);
  const existing = await store.getLead(input.workspaceId, leadId);
  if (existing) return leadResponse(existing);

  const timestamp = new Date(now()).toISOString();
  const lead = {
    workspaceId: input.workspaceId,
    leadId,
    callId: input.callId,
    agentId: stringOrUndefined(input.agentId),
    idempotencyKey: input.idempotencyKey,
    ...contact,
    interest: stringOrUndefined(input.interest),
    notes: stringOrUndefined(input.notes),
    status: "captured",
    notifyStatus: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await store.putLead(lead);
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    const original = await store.getLead(input.workspaceId, leadId);
    if (!original) throw error;
    return leadResponse(original);
  }
  await notifyOffice("lead", lead);
  return leadResponse(lead);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
