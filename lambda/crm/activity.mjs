import { formatLocal } from "./facts.mjs";

// The call note posted to the CRM record. The transcript and recording stay
// in Symantic (they hold PII and can be large); the CRM gets the summary and
// a link back. The trailing "Ref:" line is how a retry recognises a note it
// already posted.

function activityRef(callId) {
  return `Ref: ${callId}`;
}

export function buildCallActivity(facts, { appUrl } = {}) {
  const when = formatLocal(facts.endedAt ?? facts.startedAt, facts.timezone);
  const lines = [
    `<p><strong>AI receptionist call</strong>${when ? ` · ${escapeHtml(when)}` : ""}${
      facts.durationMs ? ` · ${escapeHtml(formatDuration(facts.durationMs))}` : ""
    }</p>`,
    row("Outcome", facts.outcomeLabel),
    row("Reason for call", facts.intent),
    row("Summary", facts.summary),
    row("Appointment", describeAppointment(facts.appointment, facts.timezone)),
    row("Message", facts.message),
    row("Lead notes", facts.leadNotes),
  ];
  if (appUrl && facts.phoneE164) {
    const href = `${appUrl.replace(/\/+$/, "")}/call-history?q=${encodeURIComponent(facts.phoneE164)}`;
    lines.push(`<p><a href="${escapeHtml(href)}">View this caller's calls in Symantic</a></p>`);
  }
  lines.push(`<p>${escapeHtml(activityRef(facts.callId))}</p>`);
  return {
    ref: activityRef(facts.callId),
    title: "AI receptionist call",
    occurredAt: facts.endedAt,
    html: lines.filter(Boolean).join(""),
  };
}

function describeAppointment(appointment, timezone) {
  if (!appointment) return null;
  const when = appointment.startTimeUtc
    ? formatLocal(appointment.startTimeUtc, appointment.timezone ?? timezone)
    : null;
  const service = appointment.service ? `${appointment.service} ` : "";
  if (appointment.kind === "cancelled") {
    return `Cancelled ${service}appointment${when ? ` (was ${when})` : ""}`;
  }
  const verb = appointment.kind === "rescheduled" ? "Rescheduled" : "Booked";
  return `${verb} ${service}appointment${when ? ` for ${when}` : ""}`;
}

function row(label, value) {
  if (!value) return null;
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(truncate(value, 4000))}</p>`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
