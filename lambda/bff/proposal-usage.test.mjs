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
  proratePartialMonth,
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

test("proratePartialMonth splits by remaining days inclusive of the join day", () => {
  assert.deepEqual(proratePartialMonth(310, "2026-09-01"), { amount: 310, remaining: 30, total: 30 });
  assert.deepEqual(proratePartialMonth(310, "2026-09-30"), { amount: 10.33, remaining: 1, total: 30 });
  assert.deepEqual(proratePartialMonth(300, "2026-09-16"), { amount: 150, remaining: 15, total: 30 });
});

test("firstOfNextMonthKey rolls the year over", () => {
  assert.equal(firstOfNextMonthKey("2026-09"), "2026-10-01");
  assert.equal(firstOfNextMonthKey("2026-12"), "2027-01-01");
});

test("buildProposalBilling: prorated upcoming while unpaid, full month once a payment exists", () => {
  const workspace = { tier: "repository", createdAt: "2026-09-16T10:00:00.000Z" };

  const unpaid = buildProposalBilling(workspace, "repository", [], { now, timezone: "UTC" });
  assert.equal(unpaid.monthlyPrice, 119);
  assert.equal(unpaid.priceOverridden, false);
  assert.equal(unpaid.upcoming.prorated, true);
  assert.equal(unpaid.upcoming.dueOn, "2026-10-01");
  assert.equal(unpaid.upcoming.amount, 59.5); // 119 * 15/30
  assert.match(unpaid.upcoming.basis, /Prorated 2026-09-16/);

  const paid = buildProposalBilling(workspace, "repository", [
    { paymentId: "p1", paidAt: "2026-09-16", planLabel: "Pro", amount: 59.5, receivedBy: "AJ", method: "Stripe" },
  ], { now, timezone: "UTC" });
  assert.equal(paid.upcoming.prorated, false);
  assert.equal(paid.upcoming.amount, 119);
  assert.equal(paid.upcoming.dueOn, "2026-10-01");
  assert.equal(paid.payments.length, 1);
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
