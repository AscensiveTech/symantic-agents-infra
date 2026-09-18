import assert from "node:assert/strict";
import test from "node:test";

import {
  RECEPTIONIST_PLANS,
  billedMinutes,
  buildUsage,
  costBreakdown,
  periodKey,
  resolveAccountPlan,
  resolveAgentPlan,
  resolveCallBlocklist,
} from "./receptionist-billing.mjs";

const agent = (receptionistPlan, extra = {}) => ({
  id: "agent-1",
  status: "active",
  configuration: { receptionistPlan },
  ...extra,
});

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

test("buildUsage never counts demo-seeded calls toward real billed minutes", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const plan = { plan: "starter", ...RECEPTIONIST_PLANS.starter };
  const usage = buildUsage(
    [
      call("2026-09-10T10:00:00Z", 60_000),
      call("2026-09-11T10:00:00Z", 120_000, { demoSeed: true }),
      call("2026-09-12T10:00:00Z", 180_000, { demoSeed: true }),
    ],
    { now, timezone: "UTC", plan },
  );
  // Only the one real, non-demo call (60s -> 1 billed minute) counts -
  // the 2 demo-seeded calls (2min + 3min) must never inflate real usage.
  assert.equal(usage.billingCycle.minutes, 1);
  assert.equal(usage.billingCycle.calls, 1);
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
  const plan = { plan: "starter", ...RECEPTIONIST_PLANS.starter }; // 1000 min, $349, $0.50/min
  const mk = (n) => Array.from({ length: n }, (_, i) =>
    call(`2026-09-0${(i % 9) + 1}T10:0${i % 10}:00Z`, 60_000));

  const approaching = buildUsage(mk(850), { now, timezone: "UTC", plan });
  assert.equal(approaching.billingCycle.usageState, "approaching");

  const over = buildUsage(mk(1500), { now, timezone: "UTC", plan });
  assert.equal(over.billingCycle.usageState, "overage");
  assert.equal(over.billingCycle.overageMinutes, 500);
  assert.equal(over.billingCycle.overageCharge, 250);
  assert.equal(over.billingCycle.overageChargeCapped, false);

  const capped = buildUsage(mk(3000), { now, timezone: "UTC", plan });
  assert.equal(capped.billingCycle.usageState, "capped");
  assert.equal(capped.billingCycle.blocked, true);
  assert.equal(capped.billingCycle.overageCharge, 349);
  assert.equal(capped.billingCycle.overageChargeCapped, true);
  assert.equal(capped.billingCycle.capMinute, 1000 + Math.ceil(349 / 0.5)); // 1698
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

test("resolveAgentPlan: reads the agent's own configuration.receptionistPlan", () => {
  const plan = resolveAgentPlan(agent("growth"), {});
  assert.equal(plan.plan, "growth");
  assert.equal(plan.minutes, 2000);
});

test("resolveAgentPlan: a workspace-level super-admin override wins over the agent's own choice", () => {
  const plan = resolveAgentPlan(agent("starter"), { receptionistPlanOverride: "growth" });
  assert.equal(plan.plan, "growth");
  assert.equal(plan.minutes, 2000);
});

test("resolveAgentPlan: Enterprise override uses the workspace custom numbers", () => {
  const plan = resolveAgentPlan(agent("starter"), {
    receptionistPlanOverride: "enterprise",
    enterpriseMinutes: 8000,
    enterprisePriceMonthly: 1999,
    enterpriseOveragePerMinute: 0.25,
  });
  assert.deepEqual(
    [plan.minutes, plan.priceMonthly, plan.overagePerMinute],
    [8000, 1999, 0.25],
  );
});

test("resolveAgentPlan: no plan chosen yet resolves to an empty, unmetered plan", () => {
  const plan = resolveAgentPlan(agent(""), {});
  assert.deepEqual(plan, { plan: "", label: null, priceMonthly: null, minutes: null, overagePerMinute: null });
});

test("resolveAccountPlan: sums every live agent's own plan for the account total", () => {
  const plan = resolveAccountPlan([agent("starter"), agent("growth", { id: "agent-2" })], {});
  assert.equal(plan.plan, "mixed");
  assert.equal(plan.label, "2 Agent Plans");
  assert.equal(plan.priceMonthly, 349 + 649);
  assert.equal(plan.minutes, 1000 + 2000);
});

test("resolveAccountPlan: every agent on the same plan resolves to that one plan, not 'mixed'", () => {
  const plan = resolveAccountPlan([agent("growth"), agent("growth", { id: "agent-2" })], {});
  assert.equal(plan.plan, "growth");
  assert.equal(plan.label, "Growth");
  assert.equal(plan.priceMonthly, 649 * 2);
});

test("resolveAccountPlan: agents with no plan chosen, and deleted agents, don't count", () => {
  const plan = resolveAccountPlan([
    agent("starter"),
    agent("", { id: "agent-2" }),
    agent("pro", { id: "agent-3", status: "deleted" }),
  ], {});
  assert.equal(plan.plan, "starter");
  assert.equal(plan.priceMonthly, 349);
});

test("resolveAccountPlan: no agent has chosen a plan yet resolves to an empty, unmetered plan", () => {
  const plan = resolveAccountPlan([agent("")], {});
  assert.deepEqual(plan, { plan: "", label: null, priceMonthly: null, minutes: null, overagePerMinute: null });
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

test("resolveCallBlocklist: explicit super-admin toggle wins, otherwise off by default", () => {
  assert.equal(resolveCallBlocklist({ callBlocklistEnabled: true }, { plan: "starter" }), true);
  assert.equal(resolveCallBlocklist({ callBlocklistEnabled: false }, { plan: "pro" }), false);
  assert.equal(resolveCallBlocklist({}, { plan: "enterprise" }), false);
  assert.equal(resolveCallBlocklist(null, null), false);
});

test("buildUsage counts spam calls separately without dropping them from totals", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const usage = buildUsage([
    call("2026-09-02T10:00:00Z", 60_000, { outcome: "answered" }),
    call("2026-09-03T10:00:00Z", 30_000, { outcome: "spam" }),
    call("2026-09-04T10:00:00Z", 30_000, { outcome: "spam" }),
  ], { now, timezone: "UTC", plan: resolveAgentPlan(agent("starter"), {}) });
  assert.equal(usage.billingCycle.calls, 3);
  assert.equal(usage.billingCycle.spamCalls, 2);
  assert.equal(usage.billingCycle.minutes, 3);
});

test("buildUsage breaks the cycle's minutes down per agent, most minutes first", () => {
  const now = new Date("2026-09-15T12:00:00Z");
  const usage = buildUsage([
    call("2026-09-02T10:00:00Z", 120_000, { agentId: "agent-a" }),
    call("2026-09-03T10:00:00Z", 60_000, { agentId: "agent-b" }),
    call("2026-09-04T10:00:00Z", 60_000, { agentId: "agent-b" }),
    call("2026-09-05T10:00:00Z", 30_000),
  ], { now, timezone: "UTC", plan: resolveAgentPlan(agent("starter"), {}) });
  assert.deepEqual(usage.billingCycle.agentBreakdown, [
    { agentId: "agent-a", minutes: 2, calls: 1 },
    { agentId: "agent-b", minutes: 2, calls: 2 },
    { agentId: "unassigned", minutes: 1, calls: 1 },
  ]);
});
