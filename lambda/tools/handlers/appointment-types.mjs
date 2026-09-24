import { ToolRequestError } from "./errors.mjs";

// Looks up a customer-defined appointment type by name (case-insensitive) -
// types are rendered into the generated prompt by name, not by an opaque
// id, so that's what the model naturally passes back. Returns undefined
// when the agent has no configured types, or the name doesn't match one -
// callers fall back to today's raw durationMinutes/endTime behavior.
export function resolveAppointmentType(agent, name) {
  const types = Array.isArray(agent?.configuration?.appointmentTypes)
    ? agent.configuration.appointmentTypes
    : [];
  const wanted = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!wanted) return undefined;
  return types.find((type) =>
    typeof type?.name === "string" && type.name.trim().toLowerCase() === wanted
  );
}

// Minimum Lead Time is mandatory on every configured type (0 is a valid,
// explicit "no restriction" choice) - enforced here regardless of whether
// the caller/agent already tried to book something sooner.
export function enforceMinimumLeadTime(appointmentType, startTimeUtc, now) {
  const minMinutes = Number(appointmentType?.minimumLeadTimeMin) || 0;
  if (minMinutes <= 0) return;
  const earliestAllowedMs = Number(now()) + minMinutes * 60_000;
  const startMs = Date.parse(startTimeUtc);
  if (Number.isFinite(startMs) && startMs < earliestAllowedMs) {
    throw new ToolRequestError(
      `That time is too soon - this appointment type needs at least ${formatMinutes(minMinutes)} notice.`,
      { statusCode: 409, code: "lead_time_not_met" },
    );
  }
}

// How far ahead this agent may book ("Book Up To (Days Ahead)" on the
// Calendar & Booking step): 1-60 days, 30 when never set. Mirrors
// resolveBookingWindowDays in lambda/bff/receptionist.mjs.
export function resolveBookingWindowDays(agent) {
  const raw = Math.round(Number(agent?.configuration?.bookingWindowDays));
  return Number.isFinite(raw) && raw >= 1 && raw <= 60 ? raw : 30;
}

// Enforced here, not only in the prompt - a time past the window is
// never reported as available or booked, whatever the model asks for.
export function enforceBookingWindow(agent, startTimeUtc, now) {
  const days = resolveBookingWindowDays(agent);
  const startMs = Date.parse(startTimeUtc);
  if (Number.isFinite(startMs) && startMs > Number(now()) + days * 86_400_000) {
    throw new ToolRequestError(
      `That's too far out - appointments can only be scheduled up to ${days} days ahead.`,
      { statusCode: 409, code: "beyond_booking_window" },
    );
  }
}

// The per-agent invite options: the start time at the front of the
// calendar title ("2:00 PM - Estimate Visit - Anthony"), and a reminder
// N minutes before (unset = the calendar's own default).
export function inviteOptions(agent, { startTimeUtc, timezone, service, customerName }) {
  const config = agent?.configuration ?? {};
  const reminder = Math.round(Number(config.inviteReminderMinutes));
  const parts = [service || "Appointment", customerName].filter(Boolean);
  let title;
  if (config.inviteStartTimeInTitle === true) {
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone || "UTC" })
      .format(new Date(startTimeUtc));
    title = [time, ...parts].join(" - ");
  } else if (customerName) {
    title = parts.join(" - ");
  }
  return {
    ...(title ? { title } : {}),
    ...(config.inviteReminderMinutes !== undefined && config.inviteReminderMinutes !== null && config.inviteReminderMinutes !== ""
      && Number.isFinite(reminder) && reminder >= 0 && reminder <= 1440
      ? { reminderMinutes: reminder }
      : {}),
  };
}

// The Before/After buffers pad the real calendar block (travel/setup time)
// but are never spoken to the caller - only the provider-facing calendar
// call (getAvailability/createBooking) ever sees the padded range; the
// appointment record stored for the caller keeps the unpadded, spoken range.
export function paddedProviderRange(range, appointmentType) {
  const before = Number(appointmentType?.blockBeforeMin) || 0;
  const after = Number(appointmentType?.blockAfterMin) || 0;
  if (!before && !after) return range;
  return {
    ...range,
    startTimeUtc: new Date(Date.parse(range.startTimeUtc) - before * 60_000).toISOString(),
    endTimeUtc: new Date(Date.parse(range.endTimeUtc) + after * 60_000).toISOString(),
  };
}

function formatMinutes(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}
