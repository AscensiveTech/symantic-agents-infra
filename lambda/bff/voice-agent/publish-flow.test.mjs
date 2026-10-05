// Create and update flows through the real Retell client against the
// in-memory Retell (test-support/fake-retell.mjs), which enforces Retell's
// versioning rules. No network: the boundary is the injected fetch.

import assert from "node:assert/strict";
import test from "node:test";

import { createRetellClient } from "../providers.mjs";
import { createFakeRetell } from "../test-support/fake-retell.mjs";
import { compileVoiceAgent } from "./index.mjs";
import { inspectVoiceAgent } from "./inspect.mjs";
import { BUILD, fullAgent, knowledgeBases, workspaceProfile } from "./test-fixtures.mjs";

const PHONE = "+19375550123";

async function publish(retell, agent, retellAgentId) {
  const compiled = compileVoiceAgent({ ...BUILD, agent, profile: workspaceProfile, knowledgeBases });
  const result = await retell.upsertAgent({
    retellAgentId,
    symanticAgentId: agent.id,
    agentName: agent.configuration.name,
    greeting: compiled.canonical.conversation.greeting,
    config: compiled.config,
  });
  return { compiled, result };
}

test("create, then a Role Instructions edit: only the prompt changes at Retell; voice, tools, KBs, settings, and unmanaged fields stay", async () => {
  const fake = createFakeRetell();
  const retell = createRetellClient({ apiKey: "retell-key", fetchImpl: fake.fetchImpl, terminationUri: "sip.example.com" });

  const created = await publish(retell, fullAgent());
  const agentId = created.result.retellAgentId;
  fake.seedPhone(PHONE, agentId, "latest_published");

  // The create request carried exactly what the inspector shows.
  const createLlm = fake.requests.find((request) => request.path === "/create-retell-llm");
  const view = inspectVoiceAgent({ ...BUILD, agent: fullAgent(), profile: workspaceProfile, knowledgeBases, source: "saved" });
  assert.deepEqual(createLlm.body, view.retellRequests.updateRetellLlm);
  const createAgent = fake.requests.find((request) => request.path === "/create-agent");
  const { response_engine: _engine, ...createdAgentBody } = createAgent.body;
  assert.deepEqual(createdAgentBody, view.retellRequests.updateAgent);

  const before = fake.answering(PHONE);
  assert.equal(before.llm.general_prompt, created.compiled.prompt.text);

  await publish(retell, fullAgent({ roleInstructions: "- Ask how they heard about us." }), agentId);
  const after = fake.answering(PHONE);

  assert.ok(fake.requests.some((request) => request.path === "/v2/list-phone-numbers"),
    "published updates must use Retell's current paginated phone-number endpoint");

  assert.notEqual(after.llm.general_prompt, before.llm.general_prompt);
  assert.match(after.llm.general_prompt, /Ask how they heard about us/);
  for (const field of ["begin_message", "general_tools", "knowledge_base_ids", "start_speaker", "default_dynamic_variables"]) {
    assert.deepEqual(after.llm[field], before.llm[field], field);
  }
  for (const field of ["voice_id", "ambient_sound", "ambient_sound_volume", "pronunciation_dictionary", "language", "timezone",
    "end_call_after_silence_ms", "max_call_duration_ms", "post_call_analysis_data", "begin_message_delay_ms", "webhook_events"]) {
    assert.deepEqual(after.agent[field], before.agent[field], field);
  }
  // Update requests never send response_engine.
  for (const update of fake.requests.filter((request) => request.path.startsWith("/update-agent/"))) {
    assert.equal(update.body.response_engine, undefined);
  }
});

test("clearing the ambient sound and the pronunciations on update clears them at Retell instead of keeping stale values", async () => {
  const fake = createFakeRetell();
  const retell = createRetellClient({ apiKey: "retell-key", fetchImpl: fake.fetchImpl });
  const created = await publish(retell, fullAgent());
  const agentId = created.result.retellAgentId;
  fake.seedPhone(PHONE, agentId, "latest_published");

  await publish(retell, fullAgent({ ambientSound: "", pronunciationDictionary: [] }), agentId);
  const after = fake.answering(PHONE);
  assert.equal(after.agent.ambient_sound, null);
  assert.equal(after.agent.pronunciation_dictionary, null);
  assert.equal(after.agent.voice_id, "11labs-Hailey");
});

test("turning off the first-message pause and invalidating a legacy timezone replaces stale Retell values", async () => {
  const fake = createFakeRetell();
  const retell = createRetellClient({ apiKey: "retell-key", fetchImpl: fake.fetchImpl });
  const first = compileVoiceAgent({ ...BUILD, agent: fullAgent(), profile: workspaceProfile, knowledgeBases });
  const created = await retell.upsertAgent({
    symanticAgentId: first.canonical.identity.agentId,
    agentName: first.canonical.identity.internalName,
    greeting: first.canonical.conversation.greeting,
    config: first.config,
  });
  fake.seedPhone(PHONE, created.retellAgentId, "latest_published");
  assert.equal(fake.answering(PHONE).agent.begin_message_delay_ms, 1000);
  assert.equal(fake.answering(PHONE).agent.timezone, "America/New_York");

  const changed = compileVoiceAgent({
    ...BUILD,
    agent: fullAgent({
      startSpeaker: "user",
      pauseBeforeSpeakingMs: 0,
      businessProfile: { ...fullAgent().configuration.businessProfile, timezone: "invalid" },
    }),
    profile: workspaceProfile,
    knowledgeBases,
  });
  await retell.upsertAgent({
    retellAgentId: created.retellAgentId,
    symanticAgentId: changed.canonical.identity.agentId,
    agentName: changed.canonical.identity.internalName,
    greeting: changed.canonical.conversation.greeting,
    config: changed.config,
  });
  const after = fake.answering(PHONE).agent;
  assert.equal(after.begin_message_delay_ms, 0);
  assert.equal(after.timezone, "Etc/UTC");
});
