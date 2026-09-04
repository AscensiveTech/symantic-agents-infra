import assert from "node:assert/strict";
import test from "node:test";

import {
  PROPOSAL_LIMITS,
  PROPOSAL_PLAN_PRICES,
  buildProposalBilling,
  buildProposalUsage,
  dayKey,
  firstOfNextMonthKey,
  limitsForTier,
  nextBillingDate,
  resolveProposalMonthlyPrice,
  usageStateFor,
  validProposalPayment,
} from "./proposal-usage.mjs";

const now = new Date("2026-09-15T12:00:00.000Z");

test("usageStateFor thresholds", () => {
  assert.equal(usageStateFor(0, 100), "ok");
  assert.equal(usageStateFor(79, 100), "ok");
  assert.equal(usageStateFor(80, 100), "approaching");
  assert.equal(usageStateFor(99, 100), "approaching");
  assert.equal(usageStateFor(100, 100), "reached");
  assert.equal(usageStateFor(140, 100), "reached");
  assert.equal(usageStateFor(9999, null), "ok"); // unlimited
});

test("dayKey is tz-local YYYY-MM-DD", () => {
  assert.equal(dayKey("2026-09-01T02:00:00.000Z", "America/New_York"), "2026-08-31");
  assert.equal(dayKey("2026-09-01T02:00:00.000Z", "UTC"), "2026-09-01");
});

test("limitsForTier falls back to basic for an unknown tier", () => {
  assert.deepEqual(limitsForTier("repository"), PROPOSAL_LIMITS.repository);
  assert.deepEqual(limitsForTier("nonsense"), PROPOSAL_LIMITS.basic);
});

test("buildProposalUsage shapes meters, remaining, and blocked", () => {
  const usage = buildProposalUsage(
    { proposalsGenerated: 100, signaturesSent: 40 },
    [
      { day: "2026-09-14", proposalsGenerated: 3, signaturesSent: 1 },
      { day: "2026-09-15", proposalsGenerated: 2, signaturesSent: 0 },
      { day: "2026-08-30", proposalsGenerated: 9, signaturesSent: 9 }, // other month, dropped
    ],
    [
      { period: "2026-09", proposalsGenerated: 100, signaturesSent: 40 },
      { period: "2026-08", proposalsGenerated: 12, signaturesSent: 4 },
    ],
    { tier: "repository", now, timezone: "UTC" },
  );

  assert.equal(usage.tier, "repository");
  assert.equal(usage.tierLabel, "Pro");
  assert.equal(usage.period, "2026-09");
  assert.deepEqual(usage.proposals, { used: 100, limit: 100, remaining: 0, state: "reached" });
  assert.deepEqual(usage.signatures, { used: 40, limit: 100, remaining: 60, state: "ok" });
  assert.equal(usage.blocked, true);
  assert.deepEqual(usage.days.map((d) => d.day), ["2026-09-14", "2026-09-15"]);
  assert.deepEqual(usage.months.map((m) => m.period), ["2026-09", "2026-08"]);
});

test("buildProposalUsage treats the signing tier as unlimited and never blocked", () => {
  const usage = buildProposalUsage(
    { proposalsGenerated: 5000, signaturesSent: 5000 },
    [],
    [],
    { tier: "signing", now, timezone: "UTC" },
  );
  assert.equal(usage.proposals.limit, null);
  assert.equal(usage.proposals.remaining, null);
  assert.equal(usage.proposals.state, "ok");
  assert.equal(usage.blocked, false);
});

test("buildProposalUsage defaults a missing counter to zero and an unknown tier to basic", () => {
  const usage = buildProposalUsage(null, [], [], { tier: undefined, now, timezone: "UTC" });
  assert.equal(usage.tier, "basic");
  assert.deepEqual(usage.proposals, { used: 0, limit: 25, remaining: 25, state: "ok" });
});

test("resolveProposalMonthlyPrice: tier default, then per-company override", () => {
  assert.equal(resolveProposalMonthlyPrice("repository", null), PROPOSAL_PLAN_PRICES.repository);
  assert.equal(resolveProposalMonthlyPrice("repository", { proposalPlanPriceOverride: 99 }), 99);
  assert.equal(resolveProposalMonthlyPrice("nonsense", {}), PROPOSAL_PLAN_PRICES.basic);
});

test("firstOfNextMonthKey rolls the year over", () => {
  assert.equal(firstOfNextMonthKey("2026-09"), "2026-10-01");
  assert.equal(firstOfNextMonthKey("2026-12"), "2027-01-01");
});

test("nextBillingDate anchors to the join day, clamped for short months, no proration", () => {
  // today the 15th, join day 15 -> due today
  assert.equal(nextBillingDate("2026-09-15", 15), "2026-09-15");
  // today the 10th, join day 15 -> later this month
  assert.equal(nextBillingDate("2026-09-10", 15), "2026-09-15");
  // today the 20th, join day 15 -> next month
  assert.equal(nextBillingDate("2026-09-20", 15), "2026-10-15");
  // join day 31, February -> clamped to the 28th
  assert.equal(nextBillingDate("2026-02-01", 31), "2026-02-28");
  // year rollover
  assert.equal(nextBillingDate("2026-12-20", 15), "2027-01-15");
});

test("buildProposalBilling: full monthly price due on the join day, never prorated", () => {
  const workspace = { tier: "repository", createdAt: "2026-09-16T10:00:00.000Z" };

  const billing = buildProposalBilling(workspace, "repository", [], { now, timezone: "UTC" });
  assert.equal(billing.monthlyPrice, 119);
  assert.equal(billing.priceOverridden, false);
  assert.equal(billing.upcoming.amount, 119);
  assert.equal(billing.upcoming.billingDay, 16);
  assert.equal(billing.upcoming.dueOn, "2026-09-16"); // now = 2026-09-15, join day 16 -> tomorrow
  assert.equal(billing.upcoming.prorated, undefined);
  assert.equal(billing.upcoming.basis, undefined);
});

test("buildProposalBilling honours a per-company price override", () => {
  const paid = [{ paymentId: "p1", paidAt: "2026-08-05", planLabel: "Pro", amount: 80, receivedBy: "x" }];
  const custom = buildProposalBilling(
    { tier: "repository", proposalPlanPriceOverride: 80, createdAt: "2026-08-01T00:00:00Z" },
    "repository", paid, { now, timezone: "UTC" },
  );
  assert.equal(custom.monthlyPrice, 80);
  assert.equal(custom.priceOverridden, true);
  assert.equal(custom.upcoming.amount, 80);

  // An override that equals the tier default is not a "custom rate".
  const atDefault = buildProposalBilling(
    { tier: "repository", proposalPlanPriceOverride: 119, createdAt: "2026-08-01T00:00:00Z" },
    "repository", paid, { now, timezone: "UTC" },
  );
  assert.equal(atDefault.monthlyPrice, 119);
  assert.equal(atDefault.priceOverridden, false);
});

test("validProposalPayment enforces the required fields", () => {
  assert.equal(validProposalPayment(null), null);
  assert.equal(validProposalPayment({ paidAt: "nope", planLabel: "Pro", amount: 10, receivedBy: "x" }), null);
  assert.equal(validProposalPayment({ paidAt: "2026-09-01", planLabel: "Pro", amount: -1, receivedBy: "x" }), null);
  assert.equal(validProposalPayment({ paidAt: "2026-09-01", planLabel: "Pro", amount: 10, receivedBy: "" }), null);
  assert.deepEqual(
    validProposalPayment({ paidAt: "2026-09-01", planLabel: "Pro", amount: 119, receivedBy: "Sulav", method: "Stripe", note: "  ok " }),
    { paidAt: "2026-09-01", planLabel: "Pro", amount: 119, receivedBy: "Sulav", method: "Stripe", note: "ok" },
  );
});
