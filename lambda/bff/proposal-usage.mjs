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

// Document-storage capacity per tier, in bytes. `null` = unlimited.
// Mirrors PROPOSAL_STORAGE_LIMITS_GB in lib/domain/company.ts.
const GB = 1024 ** 3;
export const PROPOSAL_STORAGE_LIMITS = {
  basic: 5 * GB,
  repository: 50 * GB,
  signing: null,
};

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
export function buildProposalUsage(monthCounter, dayRows, monthRows, { tier, now, timezone, storageBytes = null }) {
  const normalizedTier = PROPOSAL_LIMITS[tier] ? tier : "basic";
  const limits = limitsForTier(normalizedTier);
  const period = periodKey(now ?? new Date(), timezone || "UTC");

  const storageLimit = PROPOSAL_STORAGE_LIMITS[normalizedTier] ?? null;
  const storage = typeof storageBytes === "number" && Number.isFinite(storageBytes) && storageBytes >= 0
    ? {
      usedBytes: Math.round(storageBytes),
      limitBytes: storageLimit,
      state: usageStateFor(storageBytes, storageLimit),
    }
    : null;

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
    storage,
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

function daysInMonth(year, month1to12) {
  return new Date(year, month1to12, 0).getDate();
}

// First day of the month AFTER the one `YYYY-MM` names. Used for the monthly
// USAGE-quota reset date (quota resets on the calendar 1st - unrelated to
// billing, which anchors to the join day below).
export function firstOfNextMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function clampDayInMonth(y, m, day) {
  return Math.min(Math.max(1, Math.min(31, day || 1)), daysInMonth(y, m));
}

function daysBetween(fromKey, toKey) {
  const a = Date.UTC(...fromKey.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const b = Date.UTC(...toKey.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((b - a) / 86_400_000);
}

// The next billing date: the anchor day-of-month, on or after `today`, clamped
// to the target month's length (anchor on the 31st -> the 28th/30th in short
// months). No proration - every cycle is the full monthly price.
export function nextBillingDate(todayKey, anchorDay) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const clamped = clampDayInMonth(y, m, anchorDay);
  if (d <= clamped) return `${y}-${String(m).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const clampedNext = clampDayInMonth(ny, nm, anchorDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(clampedNext).padStart(2, "0")}`;
}

// The start of the current billing cycle: the anchor day-of-month, on or before
// `today`.
export function prevBillingDate(todayKey, anchorDay) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const clamped = clampDayInMonth(y, m, anchorDay);
  if (d >= clamped) return `${y}-${String(m).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const clampedPrev = clampDayInMonth(py, pm, anchorDay);
  return `${py}-${String(pm).padStart(2, "0")}-${String(clampedPrev).padStart(2, "0")}`;
}

// The day-of-month a workspace is billed on: an explicit billingAnchorDate wins,
// else the join date (createdAt).
export function billingAnchorDay(workspace, now, tz) {
  const anchor = typeof workspace?.billingAnchorDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(workspace.billingAnchorDate)
    ? workspace.billingAnchorDate.slice(0, 10)
    : (dayKey(workspace?.createdAt ?? now, tz) ?? dayKey(now, tz));
  return Number(anchor.split("-")[2]) || 1;
}

/**
 * Preview a super-admin plan change made on behalf of a customer: credit the
 * unused days of the current cycle at the OLD price, apply it to the NEW plan's
 * first charge (which is billed immediately), and re-anchor the billing cycle
 * to today. Quota is unaffected here - it always follows the live tier.
 *
 * @returns {{fromTier,toTier,fromLabel,toLabel,fromPrice,toPrice,cycleDays,
 *   unusedDays,credit,chargeToday,carryForwardCredit,newBillingDate,newAnchorDay,noChange:boolean}}
 */
export function buildPlanChangePreview(workspace, fromTier, toTier, { now, timezone }) {
  const tz = timezone || "UTC";
  const from = PROPOSAL_LIMITS[fromTier] ? fromTier : "basic";
  const to = PROPOSAL_LIMITS[toTier] ? toTier : "basic";
  const todayKey = dayKey(now, tz);
  const anchorDay = billingAnchorDay(workspace, now, tz);

  const cycleStart = prevBillingDate(todayKey, anchorDay);
  const cycleEnd = nextBillingDate(todayKey, anchorDay);
  const cycleDays = Math.max(1, daysBetween(cycleStart, cycleEnd));
  const unusedDays = Math.max(0, Math.min(cycleDays, daysBetween(todayKey, cycleEnd)));

  const fromPrice = resolveProposalMonthlyPrice(from, workspace);
  const toPrice = resolveProposalMonthlyPrice(to, { ...workspace, tier: to });

  const credit = from === to ? 0 : (money((fromPrice * unusedDays) / cycleDays) ?? 0);
  const chargeToday = Math.max(0, money(toPrice - credit) ?? 0);
  const carryForwardCredit = Math.max(0, money(credit - toPrice) ?? 0);
  const newAnchorDay = Number(todayKey.split("-")[2]) || 1;
  // today's charge covers the current cycle - the NEXT payment is a cycle out
  const dayAfter = new Date(Date.UTC(...todayKey.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) + 86_400_000)
    .toISOString().slice(0, 10);

  return {
    fromTier: from,
    toTier: to,
    fromLabel: TIER_LABELS[from],
    toLabel: TIER_LABELS[to],
    fromPrice,
    toPrice,
    cycleDays,
    unusedDays,
    credit,
    chargeToday,
    carryForwardCredit,
    newBillingDate: nextBillingDate(dayAfter, newAnchorDay),
    newAnchorDay,
    noChange: from === to,
  };
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
 * payment history, and the next billing date.
 *
 * Billing model: no proration. The customer is charged the full monthly price
 * on their join day-of-month, every month (clamped for short months).
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

  const anchorDay = billingAnchorDay(workspace, now, tz);
  const creditBalance = Math.max(0, money(workspace?.billingCreditBalance) ?? 0);
  const creditApplied = Math.min(creditBalance, monthlyPrice);
  const upcoming = {
    dueOn: nextBillingDate(dayKey(now, tz), anchorDay),
    planLabel,
    amount: money(monthlyPrice - creditApplied) ?? monthlyPrice,
    billingDay: anchorDay,
    creditBalance,
    creditApplied,
  };

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
