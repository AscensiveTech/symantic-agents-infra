// Receptionist agent configuration - the public face of the voice-agent
// pipeline in ./voice-agent/. Every export the BFF and its tests have always
// used is kept here, so callers don't need to know the pipeline's layout.
//
// See voice-agent/index.mjs for the stages, and docs/voice-agent-configuration.md
// (infra repo) for where every wizard field ends up.

import { compileVoiceAgent } from "./voice-agent/index.mjs";
import { buildVoiceAgentConfiguration } from "./voice-agent/configuration.mjs";
import { buildPrompt } from "./voice-agent/prompt.mjs";
import { buildToolPlan } from "./voice-agent/tools.mjs";

export {
  AGENT_PROFILE_FIELDS,
  CALL_HANDLING,
  effectiveProfile,
  resolveAllowedInboundCountries,
  resolveAmbientSound,
  resolveAmbientSoundVolume,
  resolveBookingWindowDays,
  resolveCallHandling,
  resolveConfiguredVoiceId,
  resolveGreeting,
  resolveLanguage,
  resolvePauseBeforeSpeakingMs,
  resolvePronunciationDictionary,
  resolveStartSpeaker,
  spokenAgentName,
} from "./voice-agent/configuration.mjs";

export function buildReceptionistPrompt(agent, workspaceProfile, { knowledgeBases } = {}) {
  const cfg = buildVoiceAgentConfiguration(agent, workspaceProfile, { knowledgeBases });
  return buildPrompt(cfg, buildToolPlan(cfg)).text;
}

/**
 * @param knowledgeBases optional [{ knowledgeBaseId, retellKnowledgeBaseId }]
 *   - when given, config.knowledgeBaseIds is filled from it.
 */
export function buildReceptionistConfig({
  workspaceId,
  agent,
  profile,
  toolBaseUrl,
  voiceId,
  knowledgeBases,
}) {
  const agentId = text(agent?.id) || text(agent?.agentId);
  if (!text(workspaceId) || !agentId) {
    throw new Error("workspaceId and Symantic agent id are required");
  }
  if (!text(toolBaseUrl)) throw new Error("toolBaseUrl is required");
  if (!text(voiceId)) throw new Error("Retell voice id is required");
  return compileVoiceAgent({ workspaceId, agent, profile, toolBaseUrl, voiceId, knowledgeBases }).config;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
