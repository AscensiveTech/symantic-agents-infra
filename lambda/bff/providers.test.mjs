import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnthropicClient,
  createRetellClient,
  createTelnyxClient,
  resolveRetellVoiceId,
} from "./providers.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Telnyx provisioning reuses customer reference and orders one local DID", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (calls.length === 1) return response({ data: [] });
    if (calls.length === 2) {
      return response({ data: [{ phone_number: "+17035550177" }] });
    }
    return response({
      data: {
        id: "order-123",
        status: "pending",
        phone_numbers: [{
          id: "telnyx-number-123",
          phone_number: "+17035550177",
        }],
      },
    });
  };
  const client = createTelnyxClient({
    apiKey: "telnyx-key",
    connectionId: "connection-123",
    fetchImpl,
  });

  const number = await client.ensureNumber({
    workspaceId: "workspace-123",
    agentId: "agent-123",
    preferredPhone: "+17035550100",
  });

  assert.deepEqual(number, {
    telnyxNumberId: "telnyx-number-123",
    telnyxPhoneNumber: "+17035550177",
    telnyxOrderId: "order-123",
  });
  assert.match(calls[0][0], /filter%5Bcustomer_reference%5D=workspace-123%3Aagent-123/);
  assert.match(calls[1][0], /filter%5Bnational_destination_code%5D=703/);
  assert.match(calls[1][0], /filter%5Bfeatures%5D%5B%5D=voice/);
  assert.equal(calls[2][0], "https://api.telnyx.com/v2/number_orders");
  assert.deepEqual(JSON.parse(calls[2][1].body), {
    phone_numbers: [{ phone_number: "+17035550177" }],
    connection_id: "connection-123",
    customer_reference: "workspace-123:agent-123",
  });
  assert.equal(calls[2][1].headers.Authorization, "Bearer telnyx-key");
  assert.equal(
    calls[2][1].headers["Idempotency-Key"],
    "symantic-workspace-123-agent-123",
  );
});

test("Telnyx provisioning returns an already-owned DID without ordering", async () => {
  const fetchImpl = async () => response({
    data: [{
      id: "telnyx-number-existing",
      phone_number: "+17035550166",
    }],
  });
  const client = createTelnyxClient({
    apiKey: "telnyx-key",
    connectionId: "connection-123",
    fetchImpl,
  });

  const number = await client.ensureNumber({
    workspaceId: "workspace-123",
    agentId: "agent-123",
  });

  assert.deepEqual(number, {
    telnyxNumberId: "telnyx-number-existing",
    telnyxPhoneNumber: "+17035550166",
  });
});

test("Telnyx ensureNumber orders a customer-chosen desiredPhone directly, skipping the search", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (calls.length === 1) return response({ data: [] });
    return response({
      data: {
        id: "order-456",
        status: "pending",
        phone_numbers: [{
          id: "telnyx-number-456",
          phone_number: "+17035550188",
        }],
      },
    });
  };
  const client = createTelnyxClient({
    apiKey: "telnyx-key",
    connectionId: "connection-123",
    fetchImpl,
  });

  const number = await client.ensureNumber({
    workspaceId: "workspace-123",
    agentId: "agent-123",
    preferredPhone: "+17035550100",
    desiredPhone: "(703) 555-0188",
  });

  assert.deepEqual(number, {
    telnyxNumberId: "telnyx-number-456",
    telnyxPhoneNumber: "+17035550188",
    telnyxOrderId: "order-456",
  });
  // Only 2 calls (owned-number check, then order) - no available_phone_numbers search.
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "https://api.telnyx.com/v2/number_orders");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    phone_numbers: [{ phone_number: "+17035550188" }],
    connection_id: "connection-123",
    customer_reference: "workspace-123:agent-123",
  });
});

test("Telnyx searchAvailableNumbers filters by area code and returns candidates", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return response({
      data: [
        {
          phone_number: "+17035550101",
          region_information: [{ region_type: "state", region_name: "Virginia" }],
        },
        { phone_number: "+17035550102" },
      ],
    });
  };
  const client = createTelnyxClient({
    apiKey: "telnyx-key",
    connectionId: "connection-123",
    fetchImpl,
  });

  const results = await client.searchAvailableNumbers({ areaCode: "703", limit: 5 });

  assert.deepEqual(results, [
    { phoneNumber: "+17035550101", region: "Virginia", locality: undefined },
    { phoneNumber: "+17035550102", region: undefined, locality: undefined },
  ]);
  assert.match(calls[0], /filter%5Bnational_destination_code%5D=703/);
  assert.match(calls[0], /filter%5Blimit%5D=5/);
});

test("Telnyx searchAvailableNumbers rejects a malformed area code", async () => {
  const client = createTelnyxClient({
    apiKey: "telnyx-key",
    connectionId: "connection-123",
    fetchImpl: async () => response({ data: [] }),
  });

  await assert.rejects(
    client.searchAvailableNumbers({ areaCode: "abc" }),
    /areaCode/,
  );
});

test("Retell upsert creates an LLM and voice agent with compiled config", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).includes("/v2/list-agents")) {
      return response([]);
    }
    if (String(url).endsWith("/create-retell-llm")) {
      return response({ llm_id: "llm-123" }, 201);
    }
    return response({ agent_id: "retell-agent-123" }, 201);
  };
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl,
  });
  const config = {
    prompt: "Compiled prompt",
    tools: [{ type: "custom", name: "lead_capture" }],
    voice: "retell-Cimo",
    transferNumbers: ["+17035550199"],
    bookingEnabled: true,
  };

  const result = await client.upsertAgent({
    symanticAgentId: "agent-123",
    agentName: "Maya",
    greeting: "Thanks for calling.",
    config,
  });

  assert.deepEqual(result, {
    retellAgentId: "retell-agent-123",
  });
  assert.equal(calls[0][0], "https://api.retellai.com/v2/list-agents?limit=1000");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    filter_criteria: { channel: { type: "string", op: "eq", value: "voice" } },
  });
  assert.equal(calls[1][0], "https://api.retellai.com/create-retell-llm");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    start_speaker: "agent",
    begin_message: "Thanks for calling.",
    general_prompt: "Compiled prompt",
    general_tools: config.tools,
    knowledge_base_ids: [],
  });
  assert.equal(calls[2][0], "https://api.retellai.com/create-agent");
  assert.deepEqual(JSON.parse(calls[2][1].body), {
    response_engine: {
      type: "retell-llm",
      llm_id: "llm-123",
    },
    voice_id: "retell-Cimo",
    agent_name: "Symantic agent-123 · Maya",
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
  });
  assert.equal(calls[2][1].headers.Authorization, "Bearer retell-key");
});

test("Retell imports a Telnyx DID and binds it to the synced agent", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    terminationUri: "sip.telnyx.com",
    sipTrunkAuthUsername: "telnyx-user",
    sipTrunkAuthPassword: "telnyx-password",
    fetchImpl: async (url, init) => {
      calls.push([String(url), init]);
      return response({
        phone_number: "+17035550177",
        phone_number_type: "custom",
        last_modification_timestamp: 1_800_000_000_000,
      }, 201);
    },
  });

  const result = await client.importPhoneNumber({
    phoneNumber: "+17035550177",
    retellAgentId: "retell-agent-123",
    nickname: "Symantic workspace-123 agent-123",
    inboundWebhookUrl: "https://api.example.com/retell/inbound-lookup",
  });

  assert.deepEqual(result, {
    retellPhoneNumberId: "+17035550177",
  });
  assert.equal(calls[0][0], "https://api.retellai.com/import-phone-number");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    phone_number: "+17035550177",
    termination_uri: "sip.telnyx.com",
    sip_trunk_auth_username: "telnyx-user",
    sip_trunk_auth_password: "telnyx-password",
    transport: "TCP",
    inbound_agents: [{ agent_id: "retell-agent-123", weight: 1 }],
    outbound_agents: [{ agent_id: "retell-agent-123", weight: 1 }],
    nickname: "Symantic workspace-123 agent-123",
    inbound_webhook_url: "https://api.example.com/retell/inbound-lookup",
  });
});

test("Retell lists voices and creates a multipart knowledge base", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl: async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("/list-voices")) {
        return response([{ voice_id: "11labs-Hailey", voice_name: "Hailey", gender: "female" }]);
      }
      return response({ knowledge_base_id: "knowledge_base-123", status: "in_progress" }, 201);
    },
  });

  assert.equal((await client.listVoices())[0].voice_id, "11labs-Hailey");
  const created = await client.createKnowledgeBase({
    name: "Symantic agent-123",
    texts: [{ title: "Customer-provided knowledge", text: "Open weekdays." }],
    files: [{ name: "policies.txt", contentType: "text/plain", data: new TextEncoder().encode("Policy") }],
  });

  assert.deepEqual(created, { knowledgeBaseId: "knowledge_base-123", status: "in_progress" });
  assert.equal(calls[1][0], "https://api.retellai.com/create-knowledge-base");
  assert.equal(calls[1][1].headers.Authorization, "Bearer retell-key");
  assert.equal(calls[1][1].headers["Content-Type"], undefined);
  assert.equal(calls[1][1].body.get("knowledge_base_name"), "Symantic agent-123");
  assert.equal(calls[1][1].body.get("knowledge_base_texts"), null);
  const uploadedFiles = calls[1][1].body.getAll("knowledge_base_files");
  assert.equal(uploadedFiles.length, 2);
  assert.equal(uploadedFiles[0].name, "Customer-provided-knowledge.txt");
  assert.equal(await uploadedFiles[0].text(), "Open weekdays.");
  assert.equal(uploadedFiles[1].name, "policies.txt");
});

test("Retell creates a knowledge base with a URL source and auto-refresh enabled", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl: async (url, init = {}) => {
      calls.push([String(url), init]);
      return response({ knowledge_base_id: "knowledge_base-456", status: "in_progress" }, 201);
    },
  });

  const created = await client.createKnowledgeBase({
    name: "Hours policy",
    urls: ["https://example.com/hours"],
    enableAutoRefresh: true,
  });

  assert.deepEqual(created, { knowledgeBaseId: "knowledge_base-456", status: "in_progress" });
  assert.equal(calls[0][1].body.get("knowledge_base_urls"), JSON.stringify(["https://example.com/hours"]));
  assert.equal(calls[0][1].body.get("enable_auto_refresh"), "true");
});

test("Retell upsert reuses a Symantic-named agent instead of creating another", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).includes("/v2/list-agents")) {
      return response([{
        agent_id: "retell-existing",
        agent_name: "Symantic agent-123 · Maya",
        response_engine: {
          type: "retell-llm",
          llm_id: "llm-existing",
        },
      }]);
    }
    return response({ ok: true });
  };
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl,
  });

  const result = await client.upsertAgent({
    symanticAgentId: "agent-123",
    agentName: "Maya",
    greeting: "Hello.",
    config: {
      prompt: "Updated prompt",
      tools: [],
      voice: "retell-Cimo",
    },
  });

  assert.deepEqual(result, {
    retellAgentId: "retell-existing",
  });
  assert.equal(calls[0][0], "https://api.retellai.com/v2/list-agents?limit=1000");
  assert.equal(
    calls[1][0],
    "https://api.retellai.com/update-retell-llm/llm-existing",
  );
  assert.equal(
    calls[2][0],
    "https://api.retellai.com/update-agent/retell-existing",
  );
  assert.ok(!calls.some(([url]) => url.endsWith("/create-agent")));
});

test("Retell upsert looks up by Symantic name after a stored agent id 404s", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (String(url).includes("/get-agent/")) {
      return response({ message: "not found" }, 404);
    }
    if (String(url).includes("/v2/list-agents")) {
      return response({
        agents: [{
          agent_id: "retell-recovered",
          agent_name: "Symantic agent-123 · Maya",
          response_engine: {
            type: "retell-llm",
            llm_id: "llm-recovered",
          },
        }],
      });
    }
    return response({ ok: true });
  };
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl,
  });

  const result = await client.upsertAgent({
    retellAgentId: "retell-stale",
    symanticAgentId: "agent-123",
    agentName: "Maya",
    greeting: "Hello.",
    config: {
      prompt: "Updated prompt",
      tools: [],
      voice: "retell-Cimo",
    },
  });

  assert.deepEqual(result, {
    retellAgentId: "retell-recovered",
  });
  assert.equal(
    calls[0][0],
    "https://api.retellai.com/get-agent/retell-stale",
  );
  assert.equal(calls[1][0], "https://api.retellai.com/v2/list-agents?limit=1000");
  assert.ok(!calls.some(([url]) => url.endsWith("/create-agent")));
});

test("Retell upsert updates the existing LLM and agent", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    if (init.method === "GET") {
      return response({
        agent_id: "retell-agent-123",
        response_engine: {
          type: "retell-llm",
          llm_id: "llm-existing",
        },
      });
    }
    return response({ ok: true });
  };
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl,
  });

  const result = await client.upsertAgent({
    retellAgentId: "retell-agent-123",
    symanticAgentId: "agent-123",
    agentName: "Maya",
    greeting: "Hello.",
    config: {
      prompt: "Updated prompt",
      tools: [],
      voice: "retell-Cimo",
    },
  });

  assert.deepEqual(result, {
    retellAgentId: "retell-agent-123",
  });
  assert.equal(
    calls[0][0],
    "https://api.retellai.com/get-agent/retell-agent-123",
  );
  assert.equal(
    calls[1][0],
    "https://api.retellai.com/update-retell-llm/llm-existing",
  );
  assert.equal(
    calls[2][0],
    "https://api.retellai.com/update-agent/retell-agent-123",
  );
  assert.equal(calls[1][1].method, "PATCH");
  assert.equal(calls[2][1].method, "PATCH");
});

test("Retell test call sends provider IDs only in the provider request", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl: async (url, init) => {
      calls.push([String(url), init]);
      return response({ call_id: "call-123", call_status: "registered" }, 201);
    },
  });

  const result = await client.startPhoneCall({
    fromNumber: "+17035550177",
    toNumber: "+17035550100",
    retellAgentId: "retell-agent-123",
    workspaceId: "workspace-123",
    agentId: "agent-123",
  });

  assert.deepEqual(result, {
    callId: "call-123",
    status: "registered",
  });
  assert.equal(calls[0][0], "https://api.retellai.com/v2/create-phone-call");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    from_number: "+17035550177",
    to_number: "+17035550100",
    override_agent_id: "retell-agent-123",
    metadata: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
      kind: "test",
    },
    retell_llm_dynamic_variables: {
      workspaceId: "workspace-123",
      agentId: "agent-123",
    },
    ignore_e164_validation: true,
  });
});

test("Retell agent body carries the call-handling settings from config.retellAgent", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl: async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url).includes("/v2/list-agents")) return response([], 200);
      if (String(url).endsWith("/create-retell-llm")) return response({ llm_id: "llm-1" }, 201);
      return response({ agent_id: "retell-agent-1" }, 201);
    },
  });

  await client.upsertAgent({
    symanticAgentId: "agent-1",
    agentName: "Maya",
    greeting: "Hi",
    config: {
      prompt: "p",
      tools: [],
      voice: "retell-Cimo",
      retellAgent: {
        end_call_after_silence_ms: 20000,
        max_call_duration_ms: 120000,
        reminder_trigger_ms: 8000,
        reminder_max_count: 1,
        post_call_analysis_data: [{ type: "boolean", name: "is_spam", description: "d" }],
      },
    },
  });

  const createAgentBody = JSON.parse(calls.find(([url]) => url.endsWith("/create-agent"))[1].body);
  assert.equal(createAgentBody.end_call_after_silence_ms, 20000);
  assert.equal(createAgentBody.max_call_duration_ms, 120000);
  assert.deepEqual(createAgentBody.post_call_analysis_data, [
    { type: "boolean", name: "is_spam", description: "d" },
  ]);
});

test("setPhoneNumberCountries PATCHes the Retell phone number with ISO codes", async () => {
  const calls = [];
  const client = createRetellClient({
    apiKey: "retell-key",
    fetchImpl: async (url, init = {}) => {
      calls.push([String(url), init]);
      return response({}, 200);
    },
  });

  await client.setPhoneNumberCountries("+17035550177", {
    allowed_inbound_country_list: ["US", "CA"],
  });
  assert.equal(calls[0][0], "https://api.retellai.com/update-phone-number/%2B17035550177");
  assert.equal(calls[0][1].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    allowed_inbound_country_list: ["US", "CA"],
  });

  await client.setPhoneNumberCountries("+17035550177", { allowed_inbound_country_list: null });
  assert.deepEqual(JSON.parse(calls[1][1].body), { allowed_inbound_country_list: [] });
});

test("voice resolver maps product labels without treating them as provider IDs", () => {
  assert.equal(resolveRetellVoiceId("Calm and natural", {
    defaultVoiceId: "retell-Cimo",
    voiceIds: {
      "Bright and energetic": "retell-Adrian",
    },
  }), "retell-Cimo");
  assert.equal(resolveRetellVoiceId("Bright and energetic", {
    defaultVoiceId: "retell-Cimo",
    voiceIds: {
      "Bright and energetic": "retell-Adrian",
    },
  }), "retell-Adrian");
});

test("Anthropic summarizeMostAskedQuestions parses the ranked digest and computes cost from usage", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
    return response({
      content: [{
        type: "text",
        text: JSON.stringify([
          { question: "Do you accept walk-ins?", count: 5, exampleQuote: "Can I just walk in?", suggestedKnowledgeBaseAddition: "Add a walk-in policy FAQ." },
        ]),
      }],
      usage: { input_tokens: 10_000, output_tokens: 500 },
    });
  };
  const client = createAnthropicClient({ apiKey: "anthropic-key", fetchImpl });

  const result = await client.summarizeMostAskedQuestions({
    calls: [
      { transcript: [{ speaker: "Caller", text: "Do you take walk-ins?" }] },
      { callSummary: "Caller asked about walk-in availability." },
    ],
  });

  assert.equal(calls[0][0], "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0][1].headers["x-api-key"], "anthropic-key");
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].question, "Do you accept walk-ins?");
  assert.equal(result.questions[0].count, 5);
  assert.equal(result.model, "claude-haiku-4-5-20251001");
  assert.equal(result.usage.inputTokens, 10_000);
  assert.equal(result.usage.outputTokens, 500);
  // (10_000 / 1e6 * 80c) + (500 / 1e6 * 400c) = 0.8c + 0.2c = 1.0c
  assert.equal(result.costCents, 1);
});

test("Anthropic summarizeMostAskedQuestions tolerates a non-JSON response by returning no questions", async () => {
  const fetchImpl = async () => response({
    content: [{ type: "text", text: "Sorry, I can't help with that." }],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  const client = createAnthropicClient({ apiKey: "anthropic-key", fetchImpl });

  const result = await client.summarizeMostAskedQuestions({ calls: [{ callSummary: "test" }] });

  assert.deepEqual(result.questions, []);
});
