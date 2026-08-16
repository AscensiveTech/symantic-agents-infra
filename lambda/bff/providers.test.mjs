import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("Retell upsert creates an LLM and voice agent with compiled config", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init]);
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
  assert.equal(calls[0][0], "https://api.retellai.com/create-retell-llm");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    begin_message: "Thanks for calling.",
    general_prompt: "Compiled prompt",
    general_tools: config.tools,
  });
  assert.equal(calls[1][0], "https://api.retellai.com/create-agent");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    response_engine: {
      type: "retell-llm",
      llm_id: "llm-123",
    },
    voice_id: "retell-Cimo",
    agent_name: "Symantic agent-123 · Maya",
  });
  assert.equal(calls[1][1].headers.Authorization, "Bearer retell-key");
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
