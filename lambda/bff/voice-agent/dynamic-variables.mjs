// Runtime (per-call) variables available to the agent's prompt, greeting,
// and tool definitions - and who supplies each one. Anything not listed here
// must never appear as {{name}} in what we send: Retell leaves an unknown
// variable in its raw "{{name}}" form, which the model would then read.
//
// Precedence at Retell (lowest -> highest): default_dynamic_variables on the
// LLM, then the inbound-call webhook's dynamic_variables (handleInboundLookup
// in index.mjs), then values collected during the call.

// Provided by Retell on every phone and web call - no configuration needed.
export const RETELL_SYSTEM_VARIABLES = Object.freeze({
  user_number: "Caller's phone number in E.164 (phone calls). Absent on web calls.",
  agent_number: "The number the caller dialed (phone calls).",
  call_id: "Retell call id - passed to every Symantic tool so results tie to the call.",
  direction: "inbound or outbound.",
  call_type: "web_call or phone_call.",
  current_time: "Current time in the agent's timezone setting.",
  session_duration: "How long the call has run so far.",
});

// {{current_time_<IANA timezone>}} - Retell renders the current time in that
// zone, including weekday and year, e.g. "Thursday, March 28, 2024 at 11:46 PM EDT".
export const RETELL_ZONED_TIME_PATTERN = /^current_time_[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

// Supplied by Symantic. Each has a default on the LLM so web/dashboard test
// calls (which skip the inbound webhook) never see a raw placeholder.
export const SYMANTIC_VARIABLES = Object.freeze({
  crm_context: {
    source: "inbound webhook - CRM caller lookup (lambda/crm), capped at a latency budget",
    default: "Not available.",
  },
});

// Also sent by the inbound webhook and the test-call request for older
// prompts. No generated prompt references them any more - the prompt uses
// Retell's own {{current_time_<zone>}} instead, which is present on every
// call type - but they're kept so an agent published before this change
// keeps working until its next save.
export const LEGACY_WEBHOOK_VARIABLES = Object.freeze(["workspaceId", "agentId", "currentTime", "timezone"]);

export const DEFAULT_DYNAMIC_VARIABLES = Object.freeze(
  Object.fromEntries(Object.entries(SYMANTIC_VARIABLES).map(([name, spec]) => [name, spec.default])),
);

export function zonedTimeVariable(timezone) {
  const name = `current_time_${timezone}`;
  return RETELL_ZONED_TIME_PATTERN.test(name) ? `{{${name}}}` : "{{current_time}}";
}

export function referencedVariables(value) {
  const found = new Set();
  const visit = (node) => {
    if (typeof node === "string") {
      for (const match of node.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) found.add(match[1]);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return [...found].sort();
}

export function isKnownVariable(name) {
  return Object.hasOwn(RETELL_SYSTEM_VARIABLES, name)
    || RETELL_ZONED_TIME_PATTERN.test(name)
    || Object.hasOwn(SYMANTIC_VARIABLES, name);
}

// Variables used in `value` that nothing at runtime would ever fill in.
export function unknownVariables(value) {
  return referencedVariables(value).filter((name) => !isKnownVariable(name));
}
