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
  // A Cal.com agent's event types replace its own Appointment Types -
  // Cal.com enforces its own notice and buffers, so neither is applied here.
  const calComEventType = await calendar.resolveEventType?.({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    appointmentType: input.appointmentType,
  });
  const appointmentType = calComEventType ? undefined : resolveAppointmentType(agent, input.appointmentType);
  const typedDuration = calComEventType?.lengthInMinutes ?? appointmentType?.durationMin;
  const range = resolveTimeRange(
    typedDuration
      ? { ...input, durationMinutes: typedDuration, endTime: undefined }
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
    agentId: input.agentId,
    appointmentType: input.appointmentType,
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
