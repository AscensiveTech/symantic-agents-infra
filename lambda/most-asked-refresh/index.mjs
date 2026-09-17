// Scheduled Lambda (EventBridge, daily at 09:00 UTC - late night across
// every continental US timezone) that auto-generates a Most Asked
// Questions digest once per billing cycle for every entitled workspace,
// so a workspace that never manually refreshes still gets a report
// partway through its cycle instead of never seeing one.
//
// Timed 15 days after the workspace's own account-creation day-of-month
// (clamped to 1-28 so it always exists, regardless of month length) -
// roughly the midpoint of a monthly cycle, per request. The billing cycle
// itself is still the plain calendar month lambda/bff/receptionist-billing.mjs
// already anchors usage/overage to - this only decides which day within
// that cycle the auto-run fires on, it doesn't re-anchor the cycle itself.
//
// Skips a workspace entirely if it already has a digest for the current
// cycle - from a manual refresh (by anyone, including a super admin) or a
// prior auto-run this same cycle - reusing the exact same
// mostAskedQuestionsCycleLimitReached() check the manual-refresh route
// enforces, so this only ever fills in a cycle nobody has refreshed yet,
// never a second regeneration.
import {
  getDefaultStore,
  getDefaultProviders,
  generateMostAskedQuestionsDigest,
  isMostAskedQuestionsEnabled,
  mostAskedQuestionsCycleLimitReached,
} from "../bff/index.mjs";

const CYCLE_MIDPOINT_OFFSET_DAYS = 15;
// Every month has at least 28 days - clamping the trigger day into 1-28
// guarantees it exists every cycle, rather than an account created on the
// 30th or 31st silently never triggering in shorter months.
const MAX_TRIGGER_DAY = 28;

// Which day-of-month (1-28, UTC) this workspace's auto-refresh fires on -
// stable for the life of the workspace, derived once from its own
// createdAt. Not workspace-timezone-aware (like the "late at night" run
// time itself, this is an approximation of "mid-cycle", not exact per
// workspace).
export function triggerDayOfMonth(createdAt) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 1;
  const day = created.getUTCDate();
  return ((day - 1 + CYCLE_MIDPOINT_OFFSET_DAYS) % MAX_TRIGGER_DAY) + 1;
}

export function isDueToday(workspace, nowMs) {
  if (!workspace?.createdAt) return false;
  return new Date(nowMs).getUTCDate() === triggerDayOfMonth(workspace.createdAt);
}

export function createHandler({
  getStore = getDefaultStore,
  getProviders = getDefaultProviders,
  now = () => Date.now(),
} = {}) {
  return async function handle() {
    const store = await getStore();
    const providers = await getProviders();
    const nowMs = now();

    const workspaces = await store.listWorkspaces();
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    for (const workspace of workspaces) {
      const workspaceId = workspace.workspaceId ?? workspace.id;
      if (!workspaceId) continue;
      try {
        if (!isDueToday(workspace, nowMs)) continue;
        if (!await isMostAskedQuestionsEnabled(store, workspaceId)) continue;

        const [profile, digests] = await Promise.all([
          store.getProfile(workspaceId),
          store.listMostAskedDigests(workspaceId),
        ]);
        const timezone = (profile && typeof profile.timezone === "string" && profile.timezone) || "UTC";
        if (mostAskedQuestionsCycleLimitReached(digests, timezone)) {
          skipped += 1;
          continue;
        }

        await generateMostAskedQuestionsDigest({
          store,
          providers,
          workspaceId,
          windowDays: 30,
          agentId: undefined,
        });
        refreshed += 1;
      } catch (error) {
        failed += 1;
        console.error(`Most-asked-questions auto-refresh failed for ${workspaceId}`, error);
      }
    }
    return { refreshed, skipped, failed };
  };
}

export const handler = createHandler();
