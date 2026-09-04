// Monthly usage quotas for RapidProposal.
//
// A proposal counts towards the monthly quota the first time it is DOWNLOADED
// or SENT FOR SIGNATURE - not when it is created. Drafts are free. Each proposal
// is counted at most once, ever (stamped `usageCountedAt` on the record); the
// unit belongs to the month of that first download/send. The count lives in a
// persistent counter row in the workspace-usage table, keyed `proposal#<YYYY-MM>`
// (and `proposal#<YYYY-MM-DD>` for the daily view), so deleting the proposal
// never decrements it.
//
// Keep PROPOSAL_LIMITS in sync with the frontend mirror at
// lib/domain/company.ts.
//
// Billing (further down) is separate from usage: payments are logged manually
// by a super admin and stored as `payment#<paidAt>#<id>` rows in the same
// table. "Upcoming payment" is a computed estimate, not a stored record.

import { periodKey } from "./receptionist-billing.mjs";

// Proposal-creation and signature-send limits per calendar month, by plan tier.
// `null` = unlimited. Mirrors PROPOSAL_LIMITS in lib/domain/company.ts.
export const PROPOSAL_LIMITS = {
  basic: { proposals: 25, signatures: 25 },
  repository: { proposals: 100, signatures: 100 },
  signing: { proposals: null, signatures: null },
};

const TIER_LABELS = { basic: "Starter", repository: "Pro", signing: "Enterprise" };

// Default monthly price per tier (USD). A super admin can override this
// per-company via `workspace.proposalPlanPriceOverride`. Mirrors
// PROPOSAL_PLAN_PRICES in lib/domain/company.ts.
export const PROPOSAL_PLAN_PRICES = { basic: 49, repository: 119, signing: 399 };

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

  const proposalsUsed = count(monthCounter?.proposalsGenerated);
  const signaturesUsed = count(monthCounter?.signaturesSent);

  const proposals = meter(proposalsUsed, limits.proposals);
  const signatures = meter(signaturesUsed, limits.signatures);

  const days = (Array.isArray(dayRows) ? dayRows : [])
    .filter((row) => typeof row?.day === "string" && row.day.startsWith(period))
    .map((row) => ({
      day: row.day,
      proposals: count(row.proposalsGenerated),
      signatures: count(row.signaturesSent),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const months = (Array.isArray(monthRows) ? monthRows : [])
    .map((row) => ({
      period: row.period,
      proposals: count(row.proposalsGenerated),
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

// --- Billing -------------------------------------------------------------

function money(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : null;
}

// The monthly price in effect for a workspace: a per-company override wins,
// else the tier default.
export function resolveProposalMonthlyPrice(tier, workspace) {
  const override = money(workspace?.proposalPlanPriceOverride);
  if (override != null) return override;
  return PROPOSAL_PLAN_PRICES[PROPOSAL_LIMITS[tier] ? tier : "basic"];
}

function daysInMonthOf(dateKey) {
  const [y, m] = dateKey.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function lastDayKeyOfMonth(dateKey) {
  const [y, m] = dateKey.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(daysInMonthOf(dateKey)).padStart(2, "0")}`;
}

// First day of the month AFTER the one `YYYY-MM` names.
export function firstOfNextMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

// Prorate a monthly price across the days from `joinDayKey` to the end of that
// month, inclusive of the join day.
export function proratePartialMonth(monthlyPrice, joinDayKey) {
  const total = daysInMonthOf(joinDayKey);
  const joinDay = Number(joinDayKey.split("-")[2]);
  const remaining = Math.max(1, Math.min(total, total - joinDay + 1));
  return { amount: money((monthlyPrice * remaining) / total) ?? 0, remaining, total };
}

function normalizePayment(row) {
  return {
    paymentId: typeof row?.paymentId === "string" ? row.paymentId : "",
    paidAt: typeof row?.paidAt === "string" ? row.paidAt : "",
    planLabel: typeof row?.planLabel === "string" ? row.planLabel : "",
    amount: money(row?.amount) ?? 0,
    receivedBy: typeof row?.receivedBy === "string" ? row.receivedBy : "",
    method: typeof row?.method === "string" ? row.method : "",
    note: typeof row?.note === "string" ? row.note : "",
    loggedByName: typeof row?.loggedByName === "string" ? row.loggedByName : "",
    createdAt: typeof row?.createdAt === "string" ? row.createdAt : "",
  };
}

/**
 * Build the RapidProposal billing view: the monthly price, the manually-logged
 * payment history, and a computed "upcoming payment" estimate.
 *
 * Billing model: prorate from the join date for the partial first month, then
 * a full charge on the 1st of every month. The upcoming row is prorated only
 * while no payment has been logged yet.
 *
 * @param {object|null} workspace   the workspace record (createdAt = join date)
 * @param {string} tier
 * @param {Array} paymentRows       `payment#...` rows
 * @param {{now:Date, timezone:string}} ctx
 */
export function buildProposalBilling(workspace, tier, paymentRows, { now, timezone }) {
  const normalizedTier = PROPOSAL_LIMITS[tier] ? tier : "basic";
  const tz = timezone || "UTC";
  const monthlyPrice = resolveProposalMonthlyPrice(normalizedTier, workspace);
  const override = money(workspace?.proposalPlanPriceOverride);
  // "Overridden" only when it actually differs from the tier default - an
  // override that equals the default is just the plan price, not a custom rate.
  const priceOverridden = override != null && override !== PROPOSAL_PLAN_PRICES[normalizedTier];
  const planLabel = TIER_LABELS[normalizedTier];

  const payments = (Array.isArray(paymentRows) ? paymentRows : [])
    .map(normalizePayment)
    .filter((p) => p.paymentId && p.paidAt)
    .sort((a, b) => `${b.paidAt}#${b.paymentId}`.localeCompare(`${a.paidAt}#${a.paymentId}`));

  const currentMonth = periodKey(now, tz);
  const joinDayKey = dayKey(workspace?.createdAt ?? now, tz) ?? dayKey(now, tz);
  const joinMonth = joinDayKey.slice(0, 7);

  let upcoming;
  if (payments.length === 0) {
    // First-ever payment: prorate the partial join month.
    const { amount, remaining, total } = proratePartialMonth(monthlyPrice, joinDayKey);
    upcoming = {
      dueOn: firstOfNextMonthKey(joinMonth),
      planLabel,
      amount,
      prorated: true,
      basis: `Prorated ${joinDayKey} – ${lastDayKeyOfMonth(joinDayKey)} (${remaining}/${total} days)`,
    };
  } else {
    upcoming = {
      dueOn: firstOfNextMonthKey(currentMonth),
      planLabel,
      amount: monthlyPrice,
      prorated: false,
      basis: "Full month",
    };
  }

  return { tier: normalizedTier, planLabel, monthlyPrice, priceOverridden, upcoming, payments };
}

// Validate a super-admin "log a payment" body. Returns a clean record (minus
// server-set fields) or null.
export function validProposalPayment(body) {
  if (!body || typeof body !== "object") return null;
  const paidAt = typeof body.paidAt === "string" ? body.paidAt.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || Number.isNaN(new Date(paidAt).getTime())) return null;
  const planLabel = typeof body.planLabel === "string" ? body.planLabel.trim() : "";
  if (!planLabel || planLabel.length > 60) return null;
  const amount = money(body.amount);
  if (amount == null) return null;
  const receivedBy = typeof body.receivedBy === "string" ? body.receivedBy.trim() : "";
  if (!receivedBy || receivedBy.length > 120) return null;
  const method = typeof body.method === "string" ? body.method.trim() : "";
  if (method.length > 60) return null;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 500) return null;
  return { paidAt, planLabel, amount, receivedBy, method, note };
}
