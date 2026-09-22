import { ToolRequestError, requireString } from "./errors.mjs";
import {
  appointmentResponse,
  isConditionalFailure,
  providerIdempotencyIds,
  slotLockId,
  stableId,
} from "./records.mjs";
import { resolveTimeRange } from "./time.mjs";
import { enforceMinimumLeadTime, paddedProviderRange, resolveAppointmentType } from "./appointment-types.mjs";

export async function handleFindAppointment(input, { store }) {
  const callerPhone = normalizePhone(
    requireString(input.callerPhone, "callerPhone"),
  );
  const start = optionalTimestamp(input.startTime, "startTime");
  const end = optionalTimestamp(input.endTime, "endTime");
  if (start && end && end <= start) {
    throw new ToolRequestError("endTime must be after startTime", {
      statusCode: 400,
      code: "invalid_request",
    });
  }
  const appointments = await store.listAppointments(input.workspaceId);
  const matches = appointments
    .filter((appointment) => {
      if (appointment.status === "cancelled") return false;
      if (normalizePhone(appointment?.customer?.phone) !== callerPhone) {
        return false;
      }
      const appointmentStart = Date.parse(appointment.startTimeUtc ?? "");
      if (Number.isNaN(appointmentStart)) return false;
      return (!start || appointmentStart >= start) &&
        (!end || appointmentStart < end);
    })
    .sort((left, right) =>
      Date.parse(left.startTimeUtc) - Date.parse(right.startTimeUtc)
    )
    .slice(0, 5)
    .map((appointment) => ({
      appointmentId: appointment.appointmentId,
      callerName: stringOrUndefined(appointment?.customer?.name),
      service: stringOrUndefined(appointment.service) || "Appointment",
      startTimeUtc: appointment.startTimeUtc,
      endTimeUtc: appointment.endTimeUtc,
      status: appointment.status,
    }));
  if (!matches.length) {
    throw new ToolRequestError(
      "I couldn't find an upcoming appointment for that phone number.",
      { statusCode: 404, code: "appointment_not_found" },
    );
  }
  return { ok: true, appointments: matches };
}

export async function handleCreateBooking(input, {
  store,
  calendar,
  now,
}) {
  requireString(input.startTime, "startTime");
  const appointmentId = stableId(
    "apt",
    input.workspaceId,
    input.idempotencyKey,
  );
  const existing = await store.getAppointment(
    input.workspaceId,
    appointmentId,
  );
  if (existing) return appointmentResponse(existing);

  const profile = await store.getBusinessProfile(input.workspaceId);
  const timezone = profile?.timezone || "UTC";
  const agent = await store.getAgent(input.workspaceId, input.agentId);
  const appointmentType = resolveAppointmentType(agent, input.appointmentType);

  // When a configured type matches, its Duration is authoritative - the
  // agent isn't meant to override how long a "Quick Call" or "On-Site
  // Visit" runs on a per-call basis.
  const range = resolveTimeRange(
    appointmentType
      ? { ...input, durationMinutes: appointmentType.durationMin, endTime: undefined }
      : input,
    timezone,
    now,
  );
  if (appointmentType) enforceMinimumLeadTime(appointmentType, range.startTimeUtc, now);
  // Before/After buffers only ever reach the provider-facing calls below -
  // the appointment record keeps the unpadded, spoken range (see
  // paddedProviderRange's own comment).
  const providerRange = appointmentType ? paddedProviderRange(range, appointmentType) : range;

  // Holds this exact (agent, time range) slot for the whole recheck+book
  // sequence below, so a second concurrent call for the same slot is
  // turned away immediately instead of racing through to the calendar
  // provider - which doesn't reject an overlapping event on its own,
  // only a literal retry of the same event id.
  const lockId = slotLockId(input.agentId, providerRange.startTimeUtc, providerRange.endTimeUtc);
  const gotLock = await store.acquireSlotLock(input.workspaceId, lockId);
  if (!gotLock) requireAvailable({ available: false });
  let providerBooking;
  try {
    const availability = await calendar.getAvailability({
      workspaceId: input.workspaceId,
      ...providerRange,
    });
    requireAvailable(availability);

    const providerIds = providerIdempotencyIds(
      input.workspaceId,
      input.idempotencyKey,
    );
    providerBooking = await calendar.createBooking({
      workspaceId: input.workspaceId,
      ...providerRange,
      ...providerIds,
      service: stringOrUndefined(appointmentType?.name) || stringOrUndefined(input.service),
      description: stringOrUndefined(input.description),
      location: stringOrUndefined(input.location) || profile?.address || undefined,
      customer: normalizeCustomer(input.customer, agent?.configuration?.bookingInviteEmail),
      callId: input.callId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!providerBooking?.providerEventId) {
      throw new Error("Calendar provider did not return an event id");
    }
  } finally {
    await store.releaseSlotLock(input.workspaceId, lockId);
  }

  const createdAt = new Date(now()).toISOString();
  const appointment = {
    workspaceId: input.workspaceId,
    appointmentId,
    callId: input.callId,
    agentId: stringOrUndefined(input.agentId),
    idempotencyKey: input.idempotencyKey,
    provider: providerBooking.provider,
    providerEventId: providerBooking.providerEventId,
    htmlLink: providerBooking.htmlLink,
    service: stringOrUndefined(appointmentType?.name) || stringOrUndefined(input.service) || "Appointment",
    customer: normalizeCustomer(input.customer, agent?.configuration?.bookingInviteEmail),
    ...range,
    status: "confirmed",
    createdAt,
    updatedAt: createdAt,
  };
  try {
    await store.putAppointment(appointment);
    return appointmentResponse(appointment);
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    const original = await store.getAppointment(
      input.workspaceId,
      appointmentId,
    );
    if (!original) throw error;
    return appointmentResponse(original);
  }
}

export async function handleRescheduleBooking(input, {
  store,
  calendar,
  now,
}) {
  const appointmentId = requireString(
    input.appointmentId,
    "appointmentId",
  );
  const appointment = await store.getAppointment(
    input.workspaceId,
    appointmentId,
  );
  if (!appointment) {
    throw new ToolRequestError("Appointment not found", {
      statusCode: 404,
      code: "appointment_not_found",
    });
  }
  if (
    appointment.lastRescheduleIdempotencyKey === input.idempotencyKey
  ) {
    return appointmentResponse(appointment);
  }
  if (appointment.status === "cancelled") {
    throw new ToolRequestError("A cancelled appointment cannot be rescheduled", {
      statusCode: 409,
      code: "appointment_cancelled",
    });
  }

  const profile = await store.getBusinessProfile(input.workspaceId);
  const timezone = profile?.timezone || appointment.timezone || "UTC";
  const range = resolveTimeRange(input, timezone, now);
  // Same race the create-booking path guards against - hold the target
  // slot for the whole recheck+reschedule sequence so a second concurrent
  // attempt at the same new time is turned away immediately.
  const lockId = slotLockId(input.agentId ?? appointment.agentId, range.startTimeUtc, range.endTimeUtc);
  const gotLock = await store.acquireSlotLock(input.workspaceId, lockId);
  if (!gotLock) requireAvailable({ available: false });
  try {
    const availability = await calendar.getAvailability({
      workspaceId: input.workspaceId,
      providerEventId: appointment.providerEventId,
      ...range,
    });
    requireAvailable(availability);
    try {
      await calendar.rescheduleBooking({
        workspaceId: input.workspaceId,
        providerEventId: appointment.providerEventId,
        ...range,
      });
    } catch (error) {
      if (!isAlreadyUpdatedError(error)) {
        if (!isRecoverableRescheduleError(error)) throw error;
        const recovered = await store.getAppointment(
          input.workspaceId,
          appointmentId,
        );
        if (
          recovered?.lastRescheduleIdempotencyKey === input.idempotencyKey
        ) {
          return appointmentResponse(recovered);
        }
        throw error;
      }
    }
  } finally {
    await store.releaseSlotLock(input.workspaceId, lockId);
  }
  const updated = await store.updateAppointment(
    input.workspaceId,
    appointmentId,
    {
      ...range,
      status: "rescheduled",
      lastRescheduleIdempotencyKey: input.idempotencyKey,
      updatedAt: new Date(now()).toISOString(),
    },
  );
  return appointmentResponse(updated);
}

export async function handleCancelBooking(input, {
  store,
  calendar,
  now,
}) {
  const appointmentId = requireString(
    input.appointmentId,
    "appointmentId",
  );
  const appointment = await store.getAppointment(
    input.workspaceId,
    appointmentId,
  );
  if (!appointment) {
    throw new ToolRequestError("Appointment not found", {
      statusCode: 404,
      code: "appointment_not_found",
    });
  }
  if (
    appointment.status === "cancelled" ||
    appointment.lastCancelIdempotencyKey === input.idempotencyKey
  ) {
    return appointmentResponse(appointment);
  }
  await calendar.cancelBooking({
    workspaceId: input.workspaceId,
    providerEventId: appointment.providerEventId,
  });
  const updated = await store.updateAppointment(
    input.workspaceId,
    appointmentId,
    {
      status: "cancelled",
      lastCancelIdempotencyKey: input.idempotencyKey,
      updatedAt: new Date(now()).toISOString(),
    },
  );
  return appointmentResponse(updated);
}

// The agent is instructed to never ask a caller for their own email, so
// customer.email is almost always empty - fall back to the workspace's
// configured Booking Invite Email (set on the agent when a calendar is
// connected) so the provider still gets a real attendee/invite-from
// address instead of no attendee at all.
function normalizeCustomer(value, fallbackEmail) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { email: stringOrUndefined(fallbackEmail) };
  }
  return {
    name: stringOrUndefined(value.name),
    phone: stringOrUndefined(value.phone),
    email: stringOrUndefined(value.email) || stringOrUndefined(fallbackEmail),
  };
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function normalizePhone(value) {
  if (typeof value !== "string") return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const timestamp = Date.parse(requireString(value, field));
  if (Number.isNaN(timestamp)) {
    throw new ToolRequestError(`${field} must be an ISO 8601 date-time`, {
      statusCode: 400,
      code: "invalid_request",
    });
  }
  return timestamp;
}

function requireAvailable(availability) {
  if (availability?.available === true) return;
  throw new ToolRequestError(
    "That time is no longer available. Please choose another time.",
    { statusCode: 409, code: "slot_unavailable" },
  );
}

function isRecoverableRescheduleError(error) {
  if ([404, 409, 410, 412].includes(error?.statusCode)) return true;
  const providerCode = String(error?.providerCode ?? error?.code ?? "");
  return /itemnotfound|not.?found|gone/i.test(providerCode);
}

function isAlreadyUpdatedError(error) {
  const details = [
    error?.providerCode,
    error?.code,
    error?.message,
  ].filter(Boolean).join(" ");
  return /already.?updated/i.test(details);
}
