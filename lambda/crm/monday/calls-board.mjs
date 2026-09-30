import { countryForE164 } from "../phone.mjs";

// The board Symantic creates in the customer's Monday account when an agent
// connects: one row per call, mirroring Call History (minus its Actions
// column). The schema is ours - customers map their own boards separately.

export const CALLS_BOARD_BASE_NAME = "Symantic AI Calls";

export const DIRECTION_LABELS = Object.freeze(["Inbound", "Outbound"]);

// Order is the column order on the board.
export const CALLS_BOARD_COLUMNS = Object.freeze([
  { key: "phone", title: "Phone", type: "phone" },
  { key: "companyName", title: "Company Name", type: "text" },
  { key: "dateTime", title: "Date & Time", type: "date" },
  { key: "duration", title: "Duration (Min)", type: "numbers" },
  { key: "direction", title: "Direction", type: "status", labels: DIRECTION_LABELS },
  { key: "outcome", title: "Outcome", type: "text" },
  { key: "intent", title: "Reason for Call", type: "text" },
  { key: "summary", title: "Summary", type: "long_text" },
  { key: "appointment", title: "Appointment Set", type: "text" },
  { key: "sentiment", title: "Sentiment", type: "text" },
  { key: "followUp", title: "Follow-Up", type: "long_text" },
  { key: "email", title: "Email", type: "email" },
  { key: "recording", title: "Recording", type: "link" },
  { key: "transcript", title: "Transcript", type: "long_text" },
]);

export function callsBoardName(agentName) {
  const suffix = typeof agentName === "string" && agentName.trim() ? ` - ${agentName.trim().slice(0, 60)}` : "";
  return `${CALLS_BOARD_BASE_NAME}${suffix}`;
}

// "Inbound"/"Outbound" from the call's own direction. Every call is inbound
// today, but an outbound call would be labelled correctly.
export function directionLabel(direction) {
  return String(direction ?? "").toLowerCase() === "outbound" ? "Outbound" : "Inbound";
}

/**
 * Column values for one call's row. `columns` maps our keys to the board's
 * column ids; anything we have no value for is left empty.
 */
export function buildCallsRow({ facts, call, columns, appUrl, transcript, followUp }) {
  const values = {};
  const set = (key, value) => {
    const id = columns?.[key];
    if (id && value !== undefined && value !== null && value !== "") values[id] = value;
  };
  const text = (value, max) => (typeof value === "string" && value.trim() ? truncate(value.trim(), max) : undefined);

  if (facts.phoneE164) {
    set("phone", { phone: facts.phoneE164, countryShortName: countryForE164(facts.phoneE164) ?? "US" });
  }
  if (facts.email) set("email", { email: facts.email, text: facts.email });
  set("companyName", text(facts.companyName, 500));
  const started = facts.startedAt ?? facts.endedAt;
  const when = started ? new Date(started) : null;
  if (when && !Number.isNaN(when.getTime())) {
    const iso = when.toISOString();
    set("dateTime", { date: iso.slice(0, 10), time: iso.slice(11, 19) });
  }
  if (Number.isFinite(facts.durationMs)) set("duration", String(Math.round(facts.durationMs / 60000)));
  set("direction", { label: directionLabel(call?.direction) });
  set("outcome", text(facts.outcomeLabel, 2000));
  set("intent", text(facts.intent, 2000));
  const summary = text(facts.summary, 5000);
  if (summary) set("summary", { text: summary });
  const booked = facts.appointment?.kind === "booked" || facts.appointment?.kind === "rescheduled";
  set("appointment", booked ? "Yes" : "No");
  set("sentiment", text(call?.userSentiment, 100));
  const followUpText = text(followUp, 5000);
  if (followUpText) set("followUp", { text: followUpText });
  if (appUrl && facts.callId) {
    set("recording", { url: `${String(appUrl).replace(/\/+$/, "")}/calls/${encodeURIComponent(facts.callId)}`, text: "Listen" });
  }
  const transcriptText = text(transcript, 50000);
  if (transcriptText) set("transcript", { text: transcriptText });
  return values;
}

export function callsRowName(facts) {
  return truncate(facts.name || facts.phoneE164 || "Caller", 255);
}

function truncate(value, max) {
  const string = String(value);
  return string.length > max ? `${string.slice(0, max - 1)}…` : string;
}
