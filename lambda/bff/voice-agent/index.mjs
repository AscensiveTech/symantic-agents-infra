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
import { buildPrompt, mentionedToolNames } from "./prompt.mjs";
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

  const unregistered = mentionedToolNames(prompt.text).filter((name) => !registered.has(name));
  if (unregistered.length) {
    add("error", "prompt_mentions_unregistered_tool",
      `The prompt mentions ${unregistered.join(", ")}, which this agent doesn't have - check the business's own instructions.`);
  }
  const customText = [cfg.customInstructions.roleInstructions, cfg.customInstructions.restrictions,
    cfg.customInstructions.exampleDialogues, cfg.customInstructions.finalReminders].join("\n");
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
