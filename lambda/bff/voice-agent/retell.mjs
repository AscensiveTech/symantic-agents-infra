// Retell payload builders - the only module that knows Retell's field names.
//
// Maps the canonical configuration, the tool plan, and the generated prompt
// onto Retell's documented API fields (docs.retellai.com, checked 2026-10-05):
//   create/update-retell-llm: start_speaker, begin_message, general_prompt,
//     general_tools, knowledge_base_ids, default_dynamic_variables
//   create/update-agent:      voice_id, language, timezone, ambient_sound,
//     ambient_sound_volume, pronunciation_dictionary, begin_message_delay_ms,
//     end_call_after_silence_ms, max_call_duration_ms, reminder_trigger_ms,
//     reminder_max_count, post_call_analysis_data, webhook_events, agent_name
//   update-phone-number:      allowed_inbound_country_list
// providers.mjs sends these bodies; it never builds them itself.

import { AMBIENT_SOUNDS, PRONUNCIATION_ALPHABETS } from "./configuration.mjs";
import { DEFAULT_DYNAMIC_VARIABLES, unknownVariables } from "./dynamic-variables.mjs";
import { buildPostCallAnalysis } from "./post-call.mjs";
import { spokenFormsRule, toSpokenText } from "./spoken-forms.mjs";

// Never surfaced in the UI - the agent nudges a silent caller once, then the
// silence timeout ends the call.
export const REMINDER_TRIGGER_MS = 8000;
export const REMINDER_MAX_COUNT = 1;

// call_started is what makes an "ongoing" row show up in Call History before
// the call ends; sent explicitly so it never depends on account defaults.
export const WEBHOOK_EVENTS = Object.freeze(["call_started", "call_ended", "call_analyzed"]);

const CUSTOM_TOOL_TIMEOUT_MS = 10_000;
const CUSTOM_TOOL_MAX_RETRY = 1;

export function toRetellTools(toolPlan, { workspaceId, agentId, toolBaseUrl }) {
  const base = String(toolBaseUrl).replace(/\/+$/, "");
  return toolPlan.map((tool) => {
    if (tool.kind === "webhook") {
      return {
        type: "custom",
        name: tool.name,
        description: tool.description,
        url: `${base}${tool.path}`,
        method: "POST",
        parameters: {
          type: "object",
          properties: {
            // Baked in per agent, so a tool call always lands on the right
            // tenant and agent whatever the model sends.
            workspaceId: { type: "string", const: workspaceId },
            agentId: { type: "string", const: agentId },
            callId: { type: "string", const: "{{call_id}}" },
            ...tool.properties,
          },
          required: ["workspaceId", "agentId", "callId", ...tool.required],
        },
        speak_during_execution: true,
        speak_after_execution: true,
        timeout_ms: CUSTOM_TOOL_TIMEOUT_MS,
        max_retry: CUSTOM_TOOL_MAX_RETRY,
      };
    }
    if (tool.kind === "transfer") {
      return {
        type: "transfer_call",
        name: tool.name,
        description: tool.description,
        transfer_destination: {
          type: "predefined",
          number: tool.number,
          // Retell's own field: DTMF digits dialed after the number connects.
          ...(tool.extension ? { extension: tool.extension } : {}),
        },
        transfer_option: {
          type: "warm_transfer",
          show_transferee_as_caller: false,
        },
        speak_during_execution: true,
        execution_message_type: "static_text",
        execution_message_description: tool.executionMessage,
      };
    }
    return { type: "end_call", name: tool.name, description: tool.description };
  });
}

export function buildRetellLlmPayload({ cfg, prompt, tools, knowledgeBaseIds }) {
  return buildRetellLlmBody({
    greeting: cfg.conversation.greeting,
    config: { startSpeaker: cfg.conversation.startSpeaker, prompt, tools, knowledgeBaseIds, spokenForms: cfg.voice.spokenForms },
  });
}

// The create-retell-llm / update-retell-llm body for the object
// buildReceptionistConfig returns. Every field is always sent, so a save
// replaces exactly the fields Symantic owns.
export function buildRetellLlmBody({ greeting, config }) {
  // "Say It As" words are written the way they're spoken only here, in what
  // Retell reads aloud; everything people read keeps the real word.
  const forms = config.spokenForms ?? [];
  const rule = spokenFormsRule(forms);
  return {
    start_speaker: config.startSpeaker === "user" ? "user" : "agent",
    begin_message: toSpokenText(greeting, forms),
    general_prompt: rule ? `${toSpokenText(config.prompt, forms)}

${rule}` : config.prompt,
    general_tools: config.tools,
    knowledge_base_ids: config.knowledgeBaseIds ?? [],
    default_dynamic_variables: DEFAULT_DYNAMIC_VARIABLES,
  };
}

// Agent-level settings that come from configuration. Identity fields
// (response_engine, agent_name) and the voice id are added by
// buildRetellAgentPayload, since they come from the stored record / secrets.
export function buildRetellAgentSettings(cfg) {
  return {
    end_call_after_silence_ms: cfg.callHandling.silenceTimeoutSec * 1000,
    max_call_duration_ms: cfg.callHandling.maxCallDurationMin * 60_000,
    reminder_trigger_ms: REMINDER_TRIGGER_MS,
    reminder_max_count: REMINDER_MAX_COUNT,
    post_call_analysis_data: buildPostCallAnalysis(cfg),
    language: cfg.voice.language,
    // The business's timezone, so Retell's own {{current_time}} and call
    // timestamps match the business even where the prompt doesn't name a zone.
    // Both fields are always sent because Retell PATCH is a merge. Omitting
    // either one would preserve a stale value from the previous published
    // version when a user clears/corrects that setting in Symantic.
    timezone: cfg.business.timezoneValid ? cfg.business.timezone : "Etc/UTC",
    begin_message_delay_ms: cfg.conversation.startSpeaker === "agent"
      ? cfg.conversation.pauseBeforeSpeakingMs
      : 0,
  };
}

// `config` is the object buildReceptionistConfig returns.
export function buildRetellAgentPayload({ config, llmId, symanticAgentId, agentName }) {
  return {
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: config.voice,
    // Sent even when unset, as null, so clearing it on an existing agent
    // actually removes it at Retell rather than leaving the previous track.
    ambient_sound: config.ambientSound || null,
    // Retell ignores this when ambient_sound is unset, so only send it
    // alongside a chosen track.
    ...(config.ambientSound ? { ambient_sound_volume: config.ambientSoundVolume } : {}),
    // Sent as null rather than omitted when empty, so clearing every entry
    // actually clears it at Retell.
    pronunciation_dictionary: config.pronunciationDictionary?.length ? config.pronunciationDictionary : null,
    agent_name: `Symantic ${symanticAgentId} · ${agentName}`,
    webhook_events: [...WEBHOOK_EVENTS],
    ...(config.retellAgent ?? {}),
  };
}

export function buildRetellPhoneNumberPayload(cfg) {
  return { allowed_inbound_country_list: cfg.callHandling.allowedInboundCountries };
}

// ---------------------------------------------------------------------------
// Validation against the documented schema. Returns a list of problems -
// empty means the payloads are well-formed. Doesn't call Retell.

const LANGUAGES = new Set([
  "en-US", "en-IN", "en-GB", "en-AU", "en-NZ", "de-DE", "es-ES", "es-419", "hi-IN", "fr-FR", "fr-CA", "ja-JP",
  "pt-PT", "pt-BR", "zh-CN", "ru-RU", "it-IT", "ko-KR", "nl-NL", "nl-BE", "pl-PL", "tr-TR", "vi-VN", "ro-RO",
]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export function validateRetellPayloads({ llm, agent }) {
  const problems = [];
  const fail = (path, message) => problems.push({ path, message });

  if (!["agent", "user"].includes(llm.start_speaker)) fail("llm.start_speaker", "must be agent or user");
  if (typeof llm.general_prompt !== "string" || !llm.general_prompt.trim()) fail("llm.general_prompt", "is empty");
  if (typeof llm.begin_message !== "string" || !llm.begin_message.trim()) {
    fail("llm.begin_message", "is empty - an empty string makes the agent wait silently for the caller");
  }
  if (!Array.isArray(llm.knowledge_base_ids) || llm.knowledge_base_ids.some((id) => typeof id !== "string" || !id)) {
    fail("llm.knowledge_base_ids", "must be a list of non-empty ids");
  }
  for (const [key, value] of Object.entries(llm.default_dynamic_variables ?? {})) {
    if (typeof value !== "string") fail(`llm.default_dynamic_variables.${key}`, "must be a string");
  }

  const names = new Set();
  (llm.general_tools ?? []).forEach((tool, index) => {
    const path = `llm.general_tools[${index}]`;
    if (!TOOL_NAME.test(tool.name ?? "")) fail(`${path}.name`, "must be 1-64 of a-z A-Z 0-9 _ -");
    if (names.has(tool.name)) fail(`${path}.name`, `duplicate tool name ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description) fail(`${path}.description`, "is required");
    if (tool.type === "custom") {
      if (!/^https:\/\//.test(tool.url ?? "")) fail(`${path}.url`, "must be an https URL");
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(tool.method)) fail(`${path}.method`, "invalid method");
      if (tool.parameters?.type !== "object") fail(`${path}.parameters`, "must be a JSON-schema object");
      for (const required of tool.parameters?.required ?? []) {
        if (!Object.hasOwn(tool.parameters.properties ?? {}, required)) {
          fail(`${path}.parameters.required`, `${required} has no property definition`);
        }
      }
      if (!(tool.timeout_ms >= 1000 && tool.timeout_ms <= 600_000)) fail(`${path}.timeout_ms`, "must be 1000-600000");
      if (!(tool.max_retry >= 0 && tool.max_retry <= 5)) fail(`${path}.max_retry`, "must be 0-5");
    } else if (tool.type === "transfer_call") {
      if (tool.transfer_destination?.type !== "predefined") fail(`${path}.transfer_destination.type`, "expected predefined");
      if (!E164.test(tool.transfer_destination?.number ?? "")) {
        fail(`${path}.transfer_destination.number`, "must be E.164 (extensions go in transfer_destination.extension)");
      }
      if (tool.transfer_destination?.extension !== undefined && !/^\d{1,6}$/.test(tool.transfer_destination.extension)) {
        fail(`${path}.transfer_destination.extension`, "must be digits");
      }
      if (!["cold_transfer", "warm_transfer", "agentic_warm_transfer"].includes(tool.transfer_option?.type)) {
        fail(`${path}.transfer_option.type`, "invalid transfer option");
      }
      if (!["prompt", "static_text"].includes(tool.execution_message_type)) {
        fail(`${path}.execution_message_type`, "must be prompt or static_text");
      }
    } else if (tool.type !== "end_call") {
      fail(`${path}.type`, `unexpected tool type ${tool.type}`);
    }
  });

  if (typeof agent.voice_id !== "string" || !agent.voice_id) fail("agent.voice_id", "is required");
  if (agent.language !== undefined && !LANGUAGES.has(agent.language)) fail("agent.language", `unsupported ${agent.language}`);
  if (agent.ambient_sound !== null && agent.ambient_sound !== undefined && !AMBIENT_SOUNDS.includes(agent.ambient_sound)) {
    fail("agent.ambient_sound", `unsupported ${agent.ambient_sound}`);
  }
  if (agent.ambient_sound_volume !== undefined && !(agent.ambient_sound_volume >= 0 && agent.ambient_sound_volume <= 2)) {
    fail("agent.ambient_sound_volume", "must be 0-2");
  }
  if (!(agent.end_call_after_silence_ms >= 10_000)) fail("agent.end_call_after_silence_ms", "minimum is 10000");
  if (!(agent.max_call_duration_ms >= 60_000 && agent.max_call_duration_ms <= 7_200_000)) {
    fail("agent.max_call_duration_ms", "must be 60000-7200000");
  }
  if (agent.begin_message_delay_ms !== undefined && !(agent.begin_message_delay_ms >= 0 && agent.begin_message_delay_ms <= 5000)) {
    fail("agent.begin_message_delay_ms", "must be 0-5000");
  }
  for (const [index, entry] of (agent.pronunciation_dictionary ?? []).entries()) {
    if (!entry.word || !entry.phoneme || !PRONUNCIATION_ALPHABETS.includes(entry.alphabet)) {
      fail(`agent.pronunciation_dictionary[${index}]`, "needs word, phoneme, and ipa/cmu alphabet");
    }
  }
  for (const [index, field] of (agent.post_call_analysis_data ?? []).entries()) {
    if (!["string", "enum", "boolean", "number"].includes(field.type) || !field.name || !field.description) {
      fail(`agent.post_call_analysis_data[${index}]`, "needs a valid type, name, and description");
    }
  }

  const unknown = unknownVariables({ llm: [llm.general_prompt, llm.begin_message, llm.general_tools] });
  if (unknown.length) {
    fail("llm", `references runtime variables nothing provides: ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
  }
  return problems;
}
