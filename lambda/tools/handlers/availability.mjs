import { resolveTimeRange } from "./time.mjs";

export async function handleAvailability(input, {
  store,
  calendar,
  now,
}) {
  const profile = await store.getBusinessProfile(input.workspaceId);
  const timezone = profile?.timezone || "UTC";
  const range = resolveTimeRange(input, timezone, now);
  const result = await calendar.getAvailability({
    workspaceId: input.workspaceId,
    ...range,
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
