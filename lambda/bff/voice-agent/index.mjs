// Voice-agent configuration pipeline:
//
//   stored agent + Business Profile
//     -> buildVoiceAgentConfiguration   (configuration.mjs, canonical)
//     -> buildToolPlan                  (tools.mjs)
//     -> buildPrompt                    (prompt.mjs)
//     -> Retell payload builders        (retell.mjs, post-call.mjs)
//     -> providers.mjs sends them
//
// compileVoiceAgent runs the whole chain once and returns every stage, so
// the publish path and the admin inspector (inspect.mjs) are guaranteed to
// show the same thing.

import { buildVoiceAgentConfiguration } from "./configuration.mjs";
import { referencedVariables } from "./dynamic-variables.mjs";
import { buildPrompt, compileCustomInstructions, mentionedToolNames } from "./prompt.mjs";
import {
  buildRetellAgentSettings,
  buildRetellLlmPayload,
  buildRetellPhoneNumberPayload,
  toRetellTools,
} from "./retell.mjs";
import { buildToolPlan, toolNames } from "./tools.mjs";

export function compileVoiceAgent({
  workspaceId,
  agent,
  profile,
  toolBaseUrl,
  voiceId,
  knowledgeBases,
}) {
  const cfg = buildVoiceAgentConfiguration(agent, profile, { knowledgeBases });
  const toolPlan = buildToolPlan(cfg);
  const prompt = buildPrompt(cfg, toolPlan);
  const tools = toRetellTools(toolPlan, { workspaceId, agentId: cfg.identity.agentId, toolBaseUrl });
  const knowledgeBaseIds = cfg.knowledge.knowledgeBases
    .map((item) => item.retellKnowledgeBaseId)
    .filter(Boolean);
  const retellAgent = buildRetellAgentSettings(cfg);

  // The shape buildReceptionistConfig has always returned - providers.mjs,
  // index.mjs, and their tests read these names.
  const config = {
    prompt: prompt.text,
    tools,
    voice: voiceId,
    transferNumbers: toolPlan.filter((tool) => tool.kind === "transfer").map((tool) => tool.number),
    bookingEnabled: cfg.scheduling.enabled,
    language: cfg.voice.language,
    startSpeaker: cfg.conversation.startSpeaker,
    pauseBeforeSpeakingMs: cfg.conversation.pauseBeforeSpeakingMs,
    retellAgent,
    allowedInboundCountries: cfg.callHandling.allowedInboundCountries,
    ambientSound: cfg.voice.ambientSound,
    ambientSoundVolume: cfg.voice.ambientSoundVolume,
    pronunciationDictionary: cfg.voice.pronunciations,
    ...(Array.isArray(knowledgeBases) ? { knowledgeBaseIds } : {}),
  };

  return {
    canonical: cfg,
    toolPlan,
    prompt,
    config,
    retell: {
      llm: buildRetellLlmPayload({ cfg, prompt: prompt.text, tools, knowledgeBaseIds }),
      agentSettings: retellAgent,
      phoneNumber: buildRetellPhoneNumberPayload(cfg),
    },
    diagnostics: diagnose(cfg, toolPlan, prompt),
  };
}

// Things worth a human's attention that don't stop a publish.
export function diagnose(cfg, toolPlan, prompt) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  const registered = new Set(toolNames(toolPlan));
  const retainedCustomInstructions = compileCustomInstructions(cfg);

  const unregistered = mentionedToolNames(prompt.text).filter((name) => !registered.has(name));
  if (unregistered.length) {
    add("error", "prompt_mentions_unregistered_tool",
      `The prompt mentions ${unregistered.join(", ")}, which this agent doesn't have - check the business's own instructions.`);
  }
  // Each conflict names the box (as labeled in the wizard), quotes the lines,
  // and says both ways to fix it. `field` and `lines` let the wizard jump
  // straight to the box.
  const addConflicts = (code, found, describe) => {
    for (const [field, lines] of groupByField(found)) {
      const { problem, fix } = describe(field);
      const box = FIELD_LABELS[field];
      out.push({
        level: "error",
        code,
        field,
        step: "guardrails",
        lines,
        message: `${problem} Where: Conversation Rules & Guardrails step → ${box} box. `
          + `${lines.length === 1 ? "Line" : "Lines"}: ${lines.map((line) => `"${line}"`).join("; ")}. To fix: ${fix}`,
      });
    }
  };
  if (!cfg.scheduling.enabled) {
    addConflicts("disabled_scheduling_in_examples", customInstructionsClaimCapability(retainedCustomInstructions, "scheduling"), (field) => ({
      problem: field === "exampleDialogues"
        ? "The Example Dialogues box has an appointment-booking example, but appointment booking is turned off."
        : `The ${FIELD_LABELS[field]} box tells the agent to book or confirm appointments, but appointment booking is turned off.`,
      fix: `delete or reword ${field === "exampleDialogues" ? "those lines" : "that text"} in the ${FIELD_LABELS[field]} box `
        + "(for example, \"I'll pass this to the team and they'll call you to set up a time\"), "
        + "or turn on appointment booking and connect a calendar on the Calendar & CRM step.",
    }));
  }
  if (!toolPlan.some((tool) => tool.kind === "transfer")) {
    addConflicts("disabled_transfers_in_custom_instructions", customInstructionsClaimCapability(retainedCustomInstructions, "transfer"), (field) => ({
      problem: field === "exampleDialogues"
        ? "The Example Dialogues box has a call-transfer example, but Call Transfers are turned off."
        : `The ${FIELD_LABELS[field]} box tells the agent to transfer calls, but Call Transfers are turned off.`,
      fix: `delete or reword ${field === "exampleDialogues" ? "those lines" : "that text"} in the ${FIELD_LABELS[field]} box `
        + "(for example, \"I'll take a message and make sure the team gets it\"), "
        + "or turn on Call Transfers and add a transfer rule on the Call Handling step.",
    }));
  }
  // The reverse: a retained line that rules out a capability the settings
  // turned on. Untouched seeded lines like this are already left out
  // (seeded-defaults.mjs); this catches edited or hand-written ones, which
  // would otherwise contradict the generated sections in the live prompt.
  if (toolPlan.some((tool) => tool.kind === "transfer")) {
    addConflicts("custom_instructions_forbid_enabled_transfers", customInstructionsForbidCapability(retainedCustomInstructions, "transfer"), (field) => ({
      problem: `The ${FIELD_LABELS[field]} box says the agent never transfers calls, but Call Transfers are turned on.`,
      fix: `delete or reword that text in the ${FIELD_LABELS[field]} box, or turn off Call Transfers on the Call Handling step.`,
    }));
  }
  if (cfg.scheduling.enabled) {
    addConflicts("custom_instructions_forbid_enabled_scheduling", customInstructionsForbidCapability(retainedCustomInstructions, "scheduling"), (field) => ({
      problem: `The ${FIELD_LABELS[field]} box says the agent can't book appointments, but appointment booking is turned on.`,
      fix: `delete or reword that text in the ${FIELD_LABELS[field]} box, or turn off appointment booking on the Calendar & CRM step.`,
    }));
  }
  const customText = [retainedCustomInstructions.roleInstructions, retainedCustomInstructions.restrictions,
    retainedCustomInstructions.exampleDialogues, retainedCustomInstructions.finalReminders].join("\n");
  const customVariables = referencedVariables(customText);
  if (customVariables.length) {
    add("warning", "custom_text_has_variables",
      `Custom instructions contain ${customVariables.map((name) => `{{${name}}}`).join(", ")}; the agent reads these literally unless Retell fills them.`);
  }
  if (!cfg.business.nameProvided) add("warning", "business_name_missing", "No business name - the agent says \"the business\".");
  if (!cfg.business.timezoneValid) {
    add("warning", "timezone_invalid", `Timezone "${cfg.business.timezoneConfigured ?? ""}" isn't a valid IANA zone - UTC is used.`);
  }
  if (!cfg.business.weeklyHours && !cfg.business.hoursText) add("warning", "hours_missing", "No business hours are set.");
  if (cfg.conversation.greetingSource === "custom" && cfg.conversation.recordingDisclosure
    && !/record|grab/i.test(cfg.conversation.greeting)) {
    add("warning", "recording_disclosure_missing",
      "Call Recording Disclosure is on, but the Custom Greeting Message doesn't mention recording.");
  }
  if (cfg.voice.language === "es-419" && cfg.conversation.greetingSource === "custom"
    && /\b(thanks|thank you|calling|how can i help)\b/i.test(cfg.conversation.greeting)) {
    add("warning", "greeting_language_mismatch", "The agent speaks Spanish, but the Custom Greeting Message looks English.");
  }
  if (cfg.transfers.allowed && !cfg.transfers.rules.length) {
    add("info", "transfers_allowed_without_rules",
      "Call Transfers are allowed but no rule has both a phrase and a number, so no transfer tool exists; requests for a person become messages.");
  }
  for (const dropped of cfg.transfers.droppedRules) {
    add("warning", "transfer_rule_unusable", `Transfer rule ${dropped.index + 1} is ignored: ${dropped.reason}.`);
  }
  if (cfg.scheduling.enabled && cfg.scheduling.provider === "calendar" && !cfg.scheduling.appointmentTypes.length) {
    add("info", "no_appointment_types", "Booking is on with no appointment types; bookings default to 30 minutes.");
  }
  if (cfg.knowledge.assignedKnowledgeBaseIds.length
    && cfg.knowledge.knowledgeBases.some((item) => item.retellKnowledgeBaseId === null)) {
    add("info", "knowledge_bases_unresolved", "Knowledge bases were not resolved to Retell ids in this view.");
  }
  if (prompt.removedInstructions.length) {
    add("info", "seeded_text_deduplicated",
      `${prompt.removedInstructions.length} seeded default line(s) in the custom fields were left out because a generated section already says the same thing.`);
  }
  if (prompt.text.length > 28_000) add("warning", "prompt_long", `The prompt is ${prompt.text.length} characters.`);
  return out;
}

const FIELD_LABELS = {
  roleInstructions: "Role Instructions",
  restrictions: "Restrictions",
  exampleDialogues: "Example Dialogues",
  finalReminders: "Final Reminders",
};

// Only absolute statements count ("This agent never transfers a call", "You
// can't book appointments"). A qualified rule - "Never transfer calls about
// billing", "Don't book appointments on Sundays" - is a valid restriction.
const NEGATION = String.raw`\b(?:never|not|cannot|can't|can not|won't|will not|don't|do not|doesn't|does not|unable to)\b`
  + String.raw`(?:\s+(?:be\s+)?(?:able|allowed|authori[sz]ed|permitted)\s+to)?\s+`;
const FORBIDS = {
  transfer: new RegExp(String.raw`${NEGATION}(?:make\s+|do\s+|perform\s+|offer\s+)?(?:any\s+)?transfer(?:s|red)?\b`
    + String.raw`(?:\s+(?:a|any|the)?\s*(?:calls?|callers?|anyone|people))?`
    + String.raw`(?:\s*,?\s*(?:under any circumstances?|at all|ever|for any reason))?$`, "i"),
  scheduling: new RegExp(String.raw`${NEGATION}(?:book|schedule|make|take|set up)\s+(?:any\s+|the\s+)?`
    + String.raw`(?:appointments?|bookings?|visits?|reservations?)`
    + String.raw`(?:\s+(?:at all|ever|over the phone|by phone|for (?:callers|anyone)|under any circumstances?))?$`, "i"),
};

function customInstructionsForbidCapability(customInstructions, capability) {
  const found = [];
  for (const field of Object.keys(FIELD_LABELS)) {
    for (const line of String(customInstructions[field] ?? "").replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\s*caller\s*:/i.test(line)) continue;
      const clauses = line
        .split(/(?<=[.!?;:])\s+|,\s*(?:but|however|instead|so|then)\s+/i)
        .map((clause) => clause.replace(/^[\s\-*•"']+|[\s.!?;:"']+$/g, ""));
      if (clauses.some((clause) => FORBIDS[capability].test(clause))) found.push({ field, line: line.trim() });
    }
  }
  return found;
}

// Customer-authored text is intentionally flexible, but it must not promise
// an operation for which this agent has no tool. Check instruction/assistant
// lines only (not caller examples), and ignore explicitly negative rules such
// as "never transfer" or "we cannot book appointments". Returns each
// offending line as it appears in its box, so the customer can find it.
function customInstructionsClaimCapability(customInstructions, capability) {
  const capabilityPattern = capability === "transfer"
    ? /\btransfer(?:red|ring|s)?\b|\b(?:connect(?:ed|ing|s)?|route(?:d|ing|s)?|send(?:ing|s)?|pass(?:ed|ing|es)?|put)\b.{0,50}\b(?:caller|call|person|human|owner|staff|team|department|representative|agent)\b|\b(?:caller|call)\b.{0,50}\b(?:connect(?:ed|ing|s)?|route(?:d|ing|s)?|send(?:ing|s)?|pass(?:ed|ing|es)?|put\s+through)\b/i
    : /\b(?:book|booked|books|schedul(?:e|ed|ing|es)|reschedul(?:e|ed|ing|es)|cancel(?:led|ing|s)?)\b|\b(?:check|consult|search|use|open|look\s+at)\b.{0,40}\b(?:calendar|availability)\b|\b(?:offer|find|give|provide|have|found)\b.{0,40}\b(?:availability|openings?|time slots?)\b|\ball set\b|\b(?:make|set\s*up|arrang(?:e|ed|ing|es)|creat(?:e|ed|ing|es)|reserv(?:e|ed|ing|es)|confirm(?:ed|ing|s)?)\b.{0,50}\b(?:appointment|booking|reservation|visit|time slot)\b|\b(?:appointment|booking|reservation|visit|time slot)\b.{0,50}\b(?:make|set\s*up|arrang(?:e|ed|ing|es)|creat(?:e|ed|ing|es)|reserv(?:e|ed|ing|es)|confirm(?:ed|ing|s)?)\b/i;
  const nonCapabilityPattern = /\b(?:never|not|do not|don't|cannot|can't|unable|not able|not authorized|must not|without)\b|\b(?:take|capture|leave|record)\b.{0,30}\bmessage\b/i;
  const found = [];
  for (const field of Object.keys(FIELD_LABELS)) {
    for (const line of String(customInstructions[field] ?? "").replace(/\r\n?/g, "\n").split("\n")) {
      if (!line.trim() || /^\s*caller\s*:/i.test(line)) continue;
      const claims = line
        .split(/(?<=[.!?;])\s+|,\s*(?:(?:but|however|instead|then)\s+)|\bbut\s+|\band\s+then\s+/i)
        .map((clause) => clause.trim())
        .some((clause) => clause && capabilityPattern.test(clause) && !nonCapabilityPattern.test(clause));
      if (claims) found.push({ field, line: line.trim() });
    }
  }
  return found;
}

// [field, lines] pairs in box order, one entry per box with conflicts.
function groupByField(found) {
  const grouped = new Map();
  for (const { field, line } of found) grouped.set(field, [...(grouped.get(field) ?? []), line]);
  return [...grouped];
}
