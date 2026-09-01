import assert from "node:assert/strict";
import test from "node:test";

import {
  RECEPTIONIST_PLANS,
  billedMinutes,
  buildUsage,
  costBreakdown,
  periodKey,
  resolvePlan,
} from "./receptionist-billing.mjs";

const call = (startedAt, durationMs, extra = {}) => ({
  callId: `call-${startedAt}`,
  startedAt,
  durationMs,
  outcome: "answered",
  ...extra,
});

test("billedMinutes rounds any talk time up to a whole minute", () => {
  assert.equal(billedMinutes(0), 0);
  assert.equal(billedMinutes(undefined), 0);
  assert.equal(billedMinutes(1), 1);
  assert.equal(billedMinutes(60_000), 1);
  assert.equal(billedMinutes(61_000), 2);
});

test("periodKey uses the workspace timezone for the billing month", () => {
  assert.equal(periodKey("2026-09-30T23:30:00-04:00", "America/New_York"), "2026-09");
  assert.equal(periodKey("2026-09-30T23:30:00-04:00", "UTC"), "2026-10");
});

test("buildUsage attributes a late-night call to the tz-local month", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const plan = { plan: "starter", ...RECEPTIONIST_PLANS.starter };
  const ny = buildUsage([call("2026-09-30T23:30:00-04:00", 90_000)], {
    now, timezone: "America/New_York", plan,
  });
  assert.equal(ny.billingCycle.period, "2026-09");
  assert.equal(ny.billingCycle.minutes, 2);
  assert.equal(ny.billingCycle.calls, 1);
});

test("buildUsage clamps the overage charge at the plan price and caps calls", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const plan = { plan: "starter", ...RECEPTIONIST_PLANS.starter }; // 1000 min, $349, $0.30/min
  const mk = (n) => Array.from({ length: n }, (_, i) =>
    call(`2026-09-0${(i % 9) + 1}T10:0${i % 10}:00Z`, 60_000));

  const approaching = buildUsage(mk(850), { now, timezone: "UTC", plan });
  assert.equal(approaching.billingCycle.usageState, "approaching");

  const over = buildUsage(mk(1500), { now, timezone: "UTC", plan });
  assert.equal(over.billingCycle.usageState, "overage");
  assert.equal(over.billingCycle.overageMinutes, 500);
  assert.equal(over.billingCycle.overageCharge, 150);
  assert.equal(over.billingCycle.overageChargeCapped, false);

  const capped = buildUsage(mk(3000), { now, timezone: "UTC", plan });
  assert.equal(capped.billingCycle.usageState, "capped");
  assert.equal(capped.billingCycle.blocked, true);
  assert.equal(capped.billingCycle.overageCharge, 349);
  assert.equal(capped.billingCycle.overageChargeCapped, true);
  assert.equal(capped.billingCycle.capMinute, 1000 + Math.ceil(349 / 0.3)); // 2164
});

test("buildUsage with no allowance never blocks and never charges overage", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const plan = { plan: "", label: null, priceMonthly: null, minutes: null, overagePerMinute: null };
  const usage = buildUsage(
    Array.from({ length: 50 }, (_, i) => call(`2026-09-01T10:${String(i).padStart(2, "0")}:00Z`, 120_000)),
    { now, timezone: "UTC", plan },
  );
  assert.equal(usage.billingCycle.usageState, "ok");
  assert.equal(usage.billingCycle.blocked, false);
  assert.equal(usage.billingCycle.overageCharge, 0);
  assert.equal(usage.minuteAllowance, null);
});

test("buildUsage months lists every month with usage, totals only, newest first", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const plan = { plan: "starter", ...RECEPTIONIST_PLANS.starter };
  const usage = buildUsage([
    call("2026-07-04T10:00:00Z", 60_000),
    call("2026-08-04T10:00:00Z", 120_000),
    call("2026-09-04T10:00:00Z", 60_000),
  ], { now, timezone: "UTC", plan });
  assert.deepEqual(usage.months.map((m) => m.period), ["2026-09", "2026-08", "2026-07"]);
  assert.equal(usage.months[1].minutes, 2);
});

test("resolvePlan: override wins immediately", () => {
  const plan = resolvePlan(
    { receptionistPlan: "starter" },
    { receptionistPlanOverride: "growth" },
    new Date("2026-09-10T00:00:00Z"),
    "UTC",
  );
  assert.equal(plan.plan, "growth");
  assert.equal(plan.minutes, 2000);
});

test("resolvePlan: queued downgrade applies only from its effective month", () => {
  const workspace = { receptionistPlanPending: "starter", receptionistPlanPendingFrom: "2026-10" };
  const sept = resolvePlan({ receptionistPlan: "growth" }, workspace, new Date("2026-09-30T23:00:00Z"), "UTC");
  assert.equal(sept.plan, "growth");
  assert.equal(sept.pendingPlanLabel, "Starter");
  assert.equal(sept.pendingPlanFrom, "2026-10");

  const oct = resolvePlan({ receptionistPlan: "growth" }, workspace, new Date("2026-10-01T00:00:00Z"), "UTC");
  assert.equal(oct.plan, "starter");
  assert.equal(oct.pendingPlanLabel, undefined);
});

test("resolvePlan: Enterprise override uses the workspace custom numbers", () => {
  const plan = resolvePlan({}, {
    receptionistPlanOverride: "enterprise",
    enterpriseMinutes: 8000,
    enterprisePriceMonthly: 1999,
    enterpriseOveragePerMinute: 0.25,
  }, new Date(), "UTC");
  assert.deepEqual(
    [plan.minutes, plan.priceMonthly, plan.overagePerMinute],
    [8000, 1999, 0.25],
  );
});

test("costBreakdown yields cost, profit and margin from actual talk time", () => {
  const c = costBreakdown(60 * 1000, 349, 0); // 1000 actual minutes, $349 revenue
  assert.equal(c.estimatedCost, 1000 * 0.105 + 7);
  assert.equal(c.grossProfit, 349 - c.estimatedCost);
  assert.ok(c.grossMarginPct > 60 && c.grossMarginPct < 70);
  const c2 = costBreakdown(0, null, 0);
  assert.equal(c2.grossProfit, null);
  assert.equal(c2.grossMarginPct, null);
});
