// Admin inspector: everything Symantic generates for one agent, stage by
// stage - user configuration -> canonical configuration -> prompt -> tool
// plan -> the exact Retell request bodies the next Save Changes would send.
//
// Read-only and side-effect free: no Retell calls, no knowledge-base
// migration. Never includes provider credentials (they never enter the
// pipeline) or storage keys.

import { compileVoiceAgent } from "./index.mjs";
import { buildRetellAgentPayload, validateRetellPayloads } from "./retell.mjs";
import { referencedVariables, RETELL_SYSTEM_VARIABLES, SYMANTIC_VARIABLES } from "./dynamic-variables.mjs";

const UNRESOLVED_VOICE = "(voice id unresolved - provider settings unavailable)";

export function inspectVoiceAgent({
  workspaceId,
  agent,
  profile,
  toolBaseUrl,
  voiceId,
  knowledgeBases,
  source,
}) {
  const compiled = compileVoiceAgent({
    workspaceId,
    agent,
    profile,
    toolBaseUrl,
    voiceId: voiceId || UNRESOLVED_VOICE,
    knowledgeBases,
  });
  const agentName = agent?.configuration?.name ?? agent?.name ?? "";
  const { response_engine: _engine, ...updateAgent } = buildRetellAgentPayload({
    config: compiled.config,
    llmId: "(existing)",
    symanticAgentId: compiled.canonical.identity.agentId,
    agentName,
  });
  const validation = validateRetellPayloads({ llm: compiled.retell.llm, agent: updateAgent });
  const variables = referencedVariables([compiled.retell.llm.general_prompt, compiled.retell.llm.begin_message, compiled.retell.llm.general_tools]);

  return {
    generatedAt: new Date().toISOString(),
    source,
    userConfiguration: {
      agent: redactAgentConfiguration(agent?.configuration),
      effectiveBusinessProfile: compiled.canonical.business,
    },
    canonicalConfiguration: compiled.canonical,
    prompt: {
      text: compiled.prompt.text,
      characters: compiled.prompt.text.length,
      sections: compiled.prompt.sections,
      toolReferences: compiled.prompt.toolReferences,
      removedInstructions: compiled.prompt.removedInstructions,
      templateGuidance: compiled.prompt.templateGuidance,
      exampleSource: compiled.prompt.exampleSource,
    },
    toolPlan: compiled.toolPlan.map(({ properties: _properties, ...tool }) => tool),
    dynamicVariables: variables.map((name) => ({
      name,
      source: Object.hasOwn(SYMANTIC_VARIABLES, name)
        ? SYMANTIC_VARIABLES[name].source
        : RETELL_SYSTEM_VARIABLES[name] ?? (name.startsWith("current_time_") ? "Retell system variable (zoned clock)" : "unknown"),
      ...(Object.hasOwn(SYMANTIC_VARIABLES, name) ? { defaultWhenMissing: SYMANTIC_VARIABLES[name].default } : {}),
    })),
    retellRequests: {
      updateRetellLlm: compiled.retell.llm,
      updateAgent,
      updatePhoneNumber: compiled.retell.phoneNumber,
    },
    validation,
    diagnostics: [
      ...compiled.diagnostics,
      ...(voiceId ? [] : [{ level: "warning", code: "voice_unresolved", message: "Voice id could not be resolved here; the publish path resolves it from provider settings." }]),
      ...(agent?.configuration?.legacyKnowledgeMigrated !== true
        && (String(agent?.configuration?.knowledgeBaseText ?? "").trim() || (agent?.configuration?.knowledgeBaseFiles ?? []).length)
        ? [{ level: "info", code: "legacy_knowledge_pending", message: "This agent still has pre-hub knowledge text/files; the next publish moves them into a new knowledge base and attaches it (not shown above yet)." }]
        : []),
    ],
  };
}

function redactAgentConfiguration(configuration) {
  if (!configuration || typeof configuration !== "object") return null;
  const { retellFingerprints: _prints, ...rest } = configuration;
  return {
    ...rest,
    ...(Array.isArray(rest.knowledgeBaseFiles)
      ? { knowledgeBaseFiles: rest.knowledgeBaseFiles.map(({ key: _key, ...file }) => file) }
      : {}),
  };
}
