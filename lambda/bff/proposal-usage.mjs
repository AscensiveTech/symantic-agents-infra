// Monthly usage quotas for RapidProposal.
//
// Unlike the AI Receptionist (whose usage is re-derived from the `calls` table),
// proposal usage is a cumulative "created this month" count that must survive
// the proposal being deleted - so it lives in a persistent counter row in the
// workspace-usage table, keyed `proposal#<YYYY-MM>` (and `proposal#<YYYY-MM-DD>`
// for the daily view). Deleting a proposal never decrements.
//
// Keep PROPOSAL_LIMITS in sync with the frontend mirror at
// lib/domain/company.ts.

import { periodKey } from "./receptionist-billing.mjs";

// Proposal-creation and signature-send limits per calendar month, by plan tier.
// `null` = unlimited. Mirrors PROPOSAL_LIMITS in lib/domain/company.ts.
export const PROPOSAL_LIMITS = {
  basic: { proposals: 25, signatures: 25 },
  repository: { proposals: 100, signatures: 100 },
  signing: { proposals: null, signatures: null },
};

const TIER_LABELS = { basic: "Starter", repository: "Pro", signing: "Enterprise" };

export function limitsForTier(tier) {
  return PROPOSAL_LIMITS[tier] ?? PROPOSAL_LIMITS.basic;
}

// tz-local YYYY-MM-DD for a timestamp.
export function dayKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return y && m && d ? `${y}-${m}-${d}` : null;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// "ok" | "approaching" (>=80% of limit) | "reached" (>=limit).
// A null limit is unlimited and always "ok".
export function usageStateFor(used, limit) {
  if (limit == null) return "ok";
  if (used >= limit) return "reached";
  if (used >= limit * 0.8) return "approaching";
  return "ok";
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function meter(used, limit) {
  return {
    used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used),
    state: usageStateFor(used, limit),
  };
}

/**
 * Shape a workspace's proposal-usage counters into the view the UI consumes.
 *
 * @param {object|null} monthCounter  the `proposal#<YYYY-MM>` row for `now`'s month
 * @param {Array} dayRows   `{ day: 'YYYY-MM-DD', proposalsCreated, signaturesSent }` for the current month
 * @param {Array} monthRows `{ period: 'YYYY-MM', proposalsCreated, signaturesSent }`, any months
 * @param {{tier:string, now:Date, timezone:string}} ctx
 */
export function buildProposalUsage(monthCounter, dayRows, monthRows, { tier, now, timezone }) {
  const normalizedTier = PROPOSAL_LIMITS[tier] ? tier : "basic";
  const limits = limitsForTier(normalizedTier);
  const period = periodKey(now ?? new Date(), timezone || "UTC");

  const proposalsUsed = count(monthCounter?.proposalsCreated);
  const signaturesUsed = count(monthCounter?.signaturesSent);

  const proposals = meter(proposalsUsed, limits.proposals);
  const signatures = meter(signaturesUsed, limits.signatures);

  const days = (Array.isArray(dayRows) ? dayRows : [])
    .filter((row) => typeof row?.day === "string" && row.day.startsWith(period))
    .map((row) => ({
      day: row.day,
      proposals: count(row.proposalsCreated),
      signatures: count(row.signaturesSent),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const months = (Array.isArray(monthRows) ? monthRows : [])
    .map((row) => ({
      period: row.period,
      proposals: count(row.proposalsCreated),
      signatures: count(row.signaturesSent),
    }))
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 6);

  return {
    tier: normalizedTier,
    tierLabel: TIER_LABELS[normalizedTier] ?? "Starter",
    period,
    proposals,
    signatures,
    blocked: proposals.state === "reached",
    days,
    months,
  };
}
