import { resolveTimeRange } from "./time.mjs";
import { enforceMinimumLeadTime, paddedProviderRange, resolveAppointmentType } from "./appointment-types.mjs";
import { effectiveProfile } from "./profile.mjs";

export async function handleAvailability(input, {
  store,
  calendar,
  now,
}) {
  const agent = await store.getAgent(input.workspaceId, input.agentId);
  const profile = effectiveProfile(agent, await store.getBusinessProfile(input.workspaceId));
  const timezone = profile?.timezone || "UTC";
  const appointmentType = resolveAppointmentType(agent, input.appointmentType);
  const range = resolveTimeRange(
    appointmentType
      ? { ...input, durationMinutes: appointmentType.durationMin, endTime: undefined }
      : input,
    timezone,
    now,
  );
  // Gate 1 (lead time) is checked here too, not just at booking time - a
  // time that fails it should never even be reported as "available" to a
  // caller asking to check first.
  enforceMinimumLeadTime(appointmentType, range.startTimeUtc, now);
  const providerRange = appointmentType ? paddedProviderRange(range, appointmentType) : range;
  const result = await calendar.getAvailability({
    workspaceId: input.workspaceId,
    ...providerRange,
  });
  return {
    ok: true,
    available: result.available === true,
    busy: Array.isArray(result.busy) ? result.busy : [],
    ...range,
    message: result.available
      ? "That time is available."
      : "That time is not available.",
  };
}
