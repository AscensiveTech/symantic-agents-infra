// Minute metering, plan resolution, and usage aggregation for the AI Receptionist.
//
// Retell bills per-account, so per-workspace usage is derived here by aggregating
// our own `calls` table. Every call counts (spam included) and bills per whole
// minute; a call belongs to the calendar month it STARTED in, in the workspace's
// timezone. Keep RECEPTIONIST_PLANS in sync with the frontend mirror at
// lib/domain/receptionist-plans.ts.

export const RECEPTIONIST_PLANS = {
  starter: { label: "Starter", priceMonthly: 349, minutes: 1000, overagePerMinute: 0.3 },
  growth: { label: "Growth", priceMonthly: 649, minutes: 2000, overagePerMinute: 0.3 },
  pro: { label: "Pro", priceMonthly: 1199, minutes: 4000, overagePerMinute: 0.3 },
  enterprise: { label: "Enterprise", priceMonthly: null, minutes: null, overagePerMinute: null },
};

export const PLAN_KEYS = Object.keys(RECEPTIONIST_PLANS);

// Premium features that a plan tier can include by default. Empty for now - the
// call blocklist is enabled per-workspace by a super admin. When the tier
// mapping is decided, add e.g. `pro: { callBlocklist: true }` here.
export const PLAN_FEATURES = {};

/**
 * Whether the premium call blocklist is available to a workspace. An explicit
 * super-admin toggle on the workspace record wins; otherwise fall back to the
 * plan-tier default (none today).
 */
export function resolveCallBlocklist(workspace, plan) {
  if (workspace?.callBlocklistEnabled === true) return true;
  return Boolean(PLAN_FEATURES[plan?.plan]?.callBlocklist);
}

// Modeled provider cost per ACTUAL talk-minute, plus a fixed monthly platform cost.
// Super-admin billing report only — never exposed to org admins.
export const PROVIDER_COST = {
  voicePerMin: 0.08,
  llmPerMin: 0.01,
  telephonyPerMin: 0.015,
  fixedMonthly: 7,
};

export function billedMinutes(durationMs) {
  return typeof durationMs === "number" && durationMs > 0
    ? Math.ceil(durationMs / 60_000)
    : 0;
}

// tz-local YYYY-MM for a timestamp.
export function periodKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    return year && month ? `${year}-${month}` : null;
  } catch {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

function nextPeriod(period) {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

// Milliseconds that `timeZone` is ahead of UTC at the given instant.
function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second,
  );
  return asUtc - date.getTime();
}

// The UTC instant of `YYYY-MM-01T00:00:00` in `timeZone`.
function zonedMonthStartUtc(period, timeZone) {
  const [year, month] = period.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), timeZone));
}

// tz-local start/end-of-month as UTC Date bounds for `now`'s calendar month.
function monthBounds(now, timeZone) {
  const tz = timeZone || "UTC";
  const period = periodKey(now, tz);
  return {
    period,
    startsOn: zonedMonthStartUtc(period, tz),
    endsOn: zonedMonthStartUtc(nextPeriod(period), tz),
  };
}

function callStart(call) {
  return call?.startedAt ?? call?.createdAt ?? null;
}

/**
 * Resolve the plan in effect for a workspace, honouring a super-admin override,
 * a queued downgrade whose effective month has arrived, and Enterprise customs.
 *
 * @returns {{plan:string,label:string|null,priceMonthly:number|null,minutes:number|null,
 *   overagePerMinute:number|null,pendingPlanLabel?:string,pendingPlanFrom?:string}}
 */
export function resolvePlan(profile, workspace, now, timezone) {
  const ws = workspace ?? {};
  const currentPeriod = periodKey(now, timezone || "UTC");

  // 1. Super-admin override always wins and is always immediate.
  const override = ws.receptionistPlanOverride;
  if (override && PLAN_KEYS.includes(override)) {
    if (override === "enterprise") {
      return {
        plan: "enterprise",
        label: "Enterprise",
        priceMonthly: numberOrNull(ws.enterprisePriceMonthly),
        minutes: numberOrNull(ws.enterpriseMinutes),
        overagePerMinute: numberOrNull(ws.enterpriseOveragePerMinute),
      };
    }
    return { plan: override, ...RECEPTIONIST_PLANS[override] };
  }

  // 2. Customer choice, pending-aware.
  let key = typeof profile?.receptionistPlan === "string" ? profile.receptionistPlan : "";
  const pending = ws.receptionistPlanPending;
  const pendingFrom = ws.receptionistPlanPendingFrom;
  if (pending && PLAN_KEYS.includes(pending) && pendingFrom && currentPeriod >= pendingFrom) {
    key = pending; // the queued downgrade is now effective
  }

  if (!PLAN_KEYS.includes(key) || key === "") {
    return { plan: "", label: null, priceMonthly: null, minutes: null, overagePerMinute: null };
  }
  const base = key === "enterprise"
    ? {
      plan: "enterprise",
      label: "Enterprise",
      priceMonthly: numberOrNull(ws.enterprisePriceMonthly),
      minutes: numberOrNull(ws.enterpriseMinutes),
      overagePerMinute: numberOrNull(ws.enterpriseOveragePerMinute),
    }
    : { plan: key, ...RECEPTIONIST_PLANS[key] };

  // Expose an unapplied queued downgrade for the UI.
  if (pending && PLAN_KEYS.includes(pending) && pendingFrom && currentPeriod < pendingFrom) {
    base.pendingPlanLabel = RECEPTIONIST_PLANS[pending]?.label ?? pending;
    base.pendingPlanFrom = pendingFrom;
  }
  return base;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Aggregate every projected call for a workspace into a billing view.
 *
 * @param {Array} allCalls  every call record for the workspace
 * @param {{now:Date, timezone:string, plan:object}} ctx
 */
export function buildUsage(allCalls, { now, timezone, plan }) {
  const tz = timezone || "UTC";
  const calls = Array.isArray(allCalls) ? allCalls : [];
  const { period, startsOn, endsOn } = monthBounds(now, tz);

  const allowance = numberOrNull(plan?.minutes);
  const price = numberOrNull(plan?.priceMonthly);
  const rate = numberOrNull(plan?.overagePerMinute) ?? RECEPTIONIST_PLANS.starter.overagePerMinute;

  // Bucket every call by its tz-local start month.
  const byMonth = new Map();
  let cycleMinutes = 0;
  let cycleCalls = 0;
  let cycleSpamCalls = 0;
  let cycleActualSeconds = 0;
  const detail = [];
  const detailCutoff = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);

  for (const call of calls) {
    const started = callStart(call);
    if (!started) continue;
    const at = new Date(started);
    if (Number.isNaN(at.getTime())) continue;
    const minutes = billedMinutes(call.durationMs);
    const bucket = periodKey(at, tz);
    const entry = byMonth.get(bucket) ?? { period: bucket, minutes: 0, calls: 0 };
    entry.minutes += minutes;
    entry.calls += 1;
    byMonth.set(bucket, entry);

    if (at >= startsOn && at < endsOn) {
      cycleMinutes += minutes;
      cycleCalls += 1;
      if (call.outcome === "spam") cycleSpamCalls += 1;
      cycleActualSeconds += Math.max(0, Math.round((call.durationMs ?? 0) / 1000));
    }
    if (at >= detailCutoff) {
      detail.push({
        callId: call.callId,
        callerName: call.callerName ?? null,
        callerNameSource: call.callerNameSource ?? null,
        callerNumber: call.callerNumber ?? null,
        startedAt: at.toISOString(),
        durationMs: call.durationMs ?? 0,
        billedMinutes: minutes,
        outcome: call.outcome ?? null,
        callSummary: call.callSummary ?? null,
        hasRecording: Boolean(call.recordingKey ?? call.hasRecording),
      });
    }
  }

  const overageMinutes = allowance != null ? Math.max(0, cycleMinutes - allowance) : 0;
  const rawOverageCharge = overageMinutes * rate;
  const overageCharge = allowance != null
    ? (price != null ? Math.min(rawOverageCharge, price) : rawOverageCharge)
    : 0;
  const overageChargeCapped = allowance != null && price != null && rawOverageCharge >= price;
  const capMinute = allowance != null && price != null
    ? allowance + Math.ceil(price / rate)
    : null;

  let usageState = "ok";
  if (allowance != null) {
    if (capMinute != null && cycleMinutes >= capMinute) usageState = "capped";
    else if (cycleMinutes >= allowance) usageState = "overage";
    else if (cycleMinutes >= allowance * 0.8) usageState = "approaching";
  }

  const { daysInCycle, daysElapsed } = cycleProgress(startsOn, endsOn, now);

  const months = [...byMonth.values()].sort((a, b) => b.period.localeCompare(a.period));

  return {
    plan: plan?.plan ?? "",
    planLabel: plan?.label ?? null,
    priceMonthly: price,
    minuteAllowance: allowance,
    overagePerMinute: allowance != null ? rate : null,
    pendingPlanLabel: plan?.pendingPlanLabel ?? null,
    pendingPlanFrom: plan?.pendingPlanFrom ?? null,
    billingCycle: {
      period,
      startsOn: startsOn.toISOString(),
      endsOn: endsOn.toISOString(),
      daysInCycle,
      daysElapsed,
      minutes: cycleMinutes,
      calls: cycleCalls,
      spamCalls: cycleSpamCalls,
      actualSeconds: cycleActualSeconds,
      overageMinutes,
      overageCharge: round2(overageCharge),
      overageChargeCapped,
      capMinute,
      usageState,
      blocked: usageState === "capped",
    },
    months,
    calls: detail.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  };
}

function cycleProgress(startsOn, endsOn, now) {
  const dayMs = 24 * 60 * 60 * 1000;
  const daysInCycle = Math.round((endsOn.getTime() - startsOn.getTime()) / dayMs);
  const elapsed = Math.floor((now.getTime() - startsOn.getTime()) / dayMs) + 1;
  return { daysInCycle, daysElapsed: Math.min(Math.max(elapsed, 1), daysInCycle) };
}

// Modeled cost / margin for the super-admin billing report.
export function costBreakdown(actualSeconds, priceMonthly, overageCharge) {
  const minutes = Math.max(0, actualSeconds) / 60;
  const voiceCost = round2(minutes * PROVIDER_COST.voicePerMin);
  const llmCost = round2(minutes * PROVIDER_COST.llmPerMin);
  const telephonyCost = round2(minutes * PROVIDER_COST.telephonyPerMin);
  const fixedCost = PROVIDER_COST.fixedMonthly;
  const estimatedCost = round2(voiceCost + llmCost + telephonyCost + fixedCost);
  const revenue = priceMonthly == null ? null : priceMonthly + (overageCharge ?? 0);
  const grossProfit = revenue == null ? null : round2(revenue - estimatedCost);
  const grossMarginPct = revenue == null || revenue === 0
    ? null
    : round2((grossProfit / revenue) * 100);
  return { voiceCost, llmCost, telephonyCost, fixedCost, estimatedCost, grossProfit, grossMarginPct };
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
