import assert from "node:assert/strict";
import test from "node:test";

import {
  PROPOSAL_LIMITS,
  buildProposalUsage,
  dayKey,
  limitsForTier,
  usageStateFor,
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
    { proposalsCreated: 100, signaturesSent: 40 },
    [
      { day: "2026-09-14", proposalsCreated: 3, signaturesSent: 1 },
      { day: "2026-09-15", proposalsCreated: 2, signaturesSent: 0 },
      { day: "2026-08-30", proposalsCreated: 9, signaturesSent: 9 }, // other month, dropped
    ],
    [
      { period: "2026-09", proposalsCreated: 100, signaturesSent: 40 },
      { period: "2026-08", proposalsCreated: 12, signaturesSent: 4 },
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
    { proposalsCreated: 5000, signaturesSent: 5000 },
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
