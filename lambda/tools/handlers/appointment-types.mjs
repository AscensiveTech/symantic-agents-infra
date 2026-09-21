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
