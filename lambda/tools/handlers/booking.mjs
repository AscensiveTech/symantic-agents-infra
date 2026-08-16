import { ToolRequestError, requireString } from "./errors.mjs";
import {
  appointmentResponse,
  isConditionalFailure,
  providerIdempotencyIds,
  stableId,
} from "./records.mjs";
import { resolveTimeRange } from "./time.mjs";

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
  const range = resolveTimeRange(input, timezone, now);
  const availability = await calendar.getAvailability({
    workspaceId: input.workspaceId,
    ...range,
  });
  requireAvailable(availability);

  const providerIds = providerIdempotencyIds(
    input.workspaceId,
    input.idempotencyKey,
  );
  const providerBooking = await calendar.createBooking({
    workspaceId: input.workspaceId,
    ...range,
    ...providerIds,
    service: stringOrUndefined(input.service),
    description: stringOrUndefined(input.description),
    location: stringOrUndefined(input.location) || profile?.address || undefined,
    customer: normalizeCustomer(input.customer),
    callId: input.callId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!providerBooking?.providerEventId) {
    throw new Error("Calendar provider did not return an event id");
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
    service: stringOrUndefined(input.service) || "Appointment",
    customer: normalizeCustomer(input.customer),
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

function normalizeCustomer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    name: stringOrUndefined(value.name),
    phone: stringOrUndefined(value.phone),
    email: stringOrUndefined(value.email),
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
