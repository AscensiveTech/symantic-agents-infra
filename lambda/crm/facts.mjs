import { toE164 } from "./phone.mjs";

// Turns a stored call row (written by the post-call Lambda) into the few
// facts a CRM needs. Pure: no I/O, no provider knowledge.

const FOLLOW_UP_OUTCOMES = new Set(["message", "lead"]);
const SKIP_OUTCOMES = new Set(["spam"]);

const OUTCOME_LABELS = {
  booked: "Appointment booked",
  escalated: "Transferred to the team",
  message: "Message taken - follow-up needed",
  lead: "New lead captured - follow-up needed",
  answered: "Question answered",
  failed: "Call failed",
  abandoned: "Caller hung up",
};

export function deriveCallFacts(call, { timezone } = {}) {
  const actions = toolActions(Array.isArray(call?.toolLog) ? call.toolLog : []);
  const successful = actions.filter((action) => action.successful);

  let appointment = null;
  for (const action of successful) {
    if (action.name === "calendar_create_booking") {
      appointment = appointmentFrom(action, "booked");
    } else if (action.name === "calendar_reschedule_booking") {
      appointment = appointmentFrom(action, "rescheduled");
    } else if (action.name === "calendar_cancel_booking") {
      appointment = appointmentFrom(action, "cancelled");
    }
  }

  const email = successful
    .flatMap(({ arguments: args }) => [args?.email, args?.customer?.email])
    .map(normalizeEmail)
    .find(Boolean) ?? null;
  const message = successful
    .filter((action) => action.name === "message_take")
    .map(({ arguments: args }) => text(args?.message))
    .find(Boolean) ?? null;
  const leadNotes = successful
    .filter((action) => action.name === "lead_capture")
    .map(({ arguments: args }) => [text(args?.interest), text(args?.notes)].filter(Boolean).join(" - "))
    .find(Boolean) ?? null;

  const outcome = text(call?.outcome) ?? "answered";
  const endedAt = text(call?.endedAt) ?? text(call?.analyzedAt) ?? text(call?.startedAt);
  const tz = validTimezone(appointment?.timezone) ?? validTimezone(timezone) ?? "UTC";
  return {
    workspaceId: call?.workspaceId,
    callId: call?.callId,
    phoneE164: toE164(call?.callerNumber ?? "", "US"),
    name: text(call?.callerName),
    email,
    startedAt: text(call?.startedAt),
    endedAt,
    durationMs: Number.isFinite(call?.durationMs) ? call.durationMs : null,
    summary: text(call?.callSummary),
    intent: text(call?.intent),
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome] ?? "Call handled",
    message,
    leadNotes,
    appointment,
    followUpRequired: FOLLOW_UP_OUTCOMES.has(outcome),
    skipReason: SKIP_OUTCOMES.has(outcome) ? outcome : null,
    timezone: tz,
  };
}

/** The local calendar date `days` after `iso`, in `timezone`. */
export function localDatePlusDays(iso, timezone, days) {
  const base = new Date(iso);
  if (Number.isNaN(base.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimezone(timezone) ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const local = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + days));
  return local.toISOString().slice(0, 10);
}

export function formatLocal(iso, timezone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ?? "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function appointmentFrom(action, kind) {
  const output = action.output ?? {};
  const args = action.arguments ?? {};
  return {
    kind,
    appointmentId: text(output.appointmentId) ?? text(args.appointmentId),
    startTimeUtc: text(output.startTimeUtc) ?? text(args.startTimeUtc),
    timezone: text(output.timezone),
    service: text(args.service),
  };
}

function toolActions(toolLog) {
  const results = new Map(
    toolLog
      .filter((entry) => entry?.role === "tool_call_result")
      .map((entry) => [entry.tool_call_id, entry]),
  );
  return toolLog
    .filter((entry) => entry?.role === "tool_call_invocation")
    .map((invocation) => {
      const result = results.get(invocation.tool_call_id);
      const output = parseObject(result?.content) ?? {};
      return {
        name: text(invocation.name),
        arguments: parseObject(invocation.arguments) ?? {},
        output,
        successful: Boolean(result) && result.successful !== false && output.ok !== false,
      };
    });
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEmail(value) {
  const email = text(value)?.toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function validTimezone(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
