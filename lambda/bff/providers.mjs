const TELNYX_BASE_URL = "https://api.telnyx.com/v2";
const RETELL_BASE_URL = "https://api.retellai.com";

export class ProviderRequestError extends Error {
  constructor(provider, message, {
    providerStatus,
    details,
  } = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = "provider_request_failed";
    this.statusCode = 502;
    this.provider = provider;
    this.providerStatus = providerStatus;
    this.details = details;
  }
}

export function createTelnyxClient({
  apiKey,
  connectionId,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  ),
}) {
  requireCredential(apiKey, "Telnyx API key");

  async function getPhoneNumber(searchParams) {
    const url = new URL(`${TELNYX_BASE_URL}/phone_numbers`);
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("page[size]", "1");
    const result = await telnyxRequest(url);
    const number = result?.data?.[0];
    return isProvisionedNumber(number) ? number : null;
  }

  async function telnyxRequest(url, {
    method = "GET",
    body,
    headers = {},
  } = {}) {
    return requestJson(fetchImpl, url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, "Telnyx");
  }

  // Tags a Telnyx number with the agent's Receptionist Name, so it's
  // identifiable in Telnyx's own number list (the "Connection/Application"
  // column can't do this - every number intentionally shares one SIP
  // connection - but Telnyx's per-number "tags" field is built for exactly
  // this). Cosmetic only: a failure here must never fail provisioning.
  async function tagNumber(telnyxNumberId, agentName) {
    if (typeof agentName !== "string" || !agentName.trim()) return;
    await telnyxRequest(
      `${TELNYX_BASE_URL}/phone_numbers/${encodeURIComponent(telnyxNumberId)}`,
      { method: "PATCH", body: { tags: [agentName.trim()] } },
    ).catch(() => {});
  }

  return {
    // Lets the customer pick from real available numbers (by area code)
    // before an agent orders one, instead of only the best-effort
    // auto-pick ensureNumber falls back to below.
    async searchAvailableNumbers({ areaCode, limit = 10 } = {}) {
      const availableUrl = new URL(
        `${TELNYX_BASE_URL}/available_phone_numbers`,
      );
      availableUrl.searchParams.set("filter[country_code]", "US");
      availableUrl.searchParams.set("filter[phone_number_type]", "local");
      availableUrl.searchParams.append("filter[features][]", "voice");
      availableUrl.searchParams.set("filter[limit]", String(Math.min(Math.max(1, Number(limit) || 10), 20)));
      if (typeof areaCode === "string" && areaCode.length > 0) {
        const normalizedAreaCode = areaCode.replace(/\D/g, "");
        if (!/^\d{3}$/.test(normalizedAreaCode)) {
          throw new ProviderRequestError("Telnyx", "areaCode must be exactly 3 digits");
        }
        availableUrl.searchParams.set("filter[national_destination_code]", normalizedAreaCode);
      }
      const result = await telnyxRequest(availableUrl);
      return (result?.data ?? [])
        .filter((candidate) => typeof candidate?.phone_number === "string" && candidate.phone_number)
        .map((candidate) => ({
          phoneNumber: candidate.phone_number,
          region: stringOrUndefined(candidate?.region_information?.[0]?.region_name),
          locality: stringOrUndefined(candidate?.region_information?.find((r) => r?.region_type === "rate_center")?.region_name),
        }));
    },

    async ensureNumber({
      workspaceId,
      agentId,
      preferredPhone,
      desiredPhone,
      agentName,
    }) {
      const customerReference = `${required(workspaceId, "workspaceId")}:${
        required(agentId, "agentId")
      }`;
      const owned = await getPhoneNumber({
        "filter[customer_reference]": customerReference,
      });
      if (owned) return telnyxNumber(owned);

      let phoneNumber = normalizeE164ForTelnyx(desiredPhone);
      if (!phoneNumber) {
        const availableUrl = new URL(
          `${TELNYX_BASE_URL}/available_phone_numbers`,
        );
        availableUrl.searchParams.set("filter[country_code]", "US");
        availableUrl.searchParams.set("filter[phone_number_type]", "local");
        availableUrl.searchParams.append("filter[features][]", "voice");
        availableUrl.searchParams.set("filter[limit]", "1");
        availableUrl.searchParams.set("filter[best_effort]", "true");
        const areaCode = northAmericanAreaCode(preferredPhone);
        if (areaCode) {
          availableUrl.searchParams.set(
            "filter[national_destination_code]",
            areaCode,
          );
        }
        const availableResult = await telnyxRequest(availableUrl);
        phoneNumber = availableResult?.data?.[0]?.phone_number;
      }
      if (typeof phoneNumber !== "string" || !phoneNumber) {
        throw new ProviderRequestError(
          "Telnyx",
          "No voice-capable Telnyx phone number is currently available",
        );
      }
      if (typeof connectionId !== "string" || !connectionId) {
        throw new ProviderRequestError(
          "Telnyx",
          "Telnyx secret must contain connectionId for the preconfigured Retell SIP connection",
        );
      }

      const idempotencyKey = `symantic-${workspaceId}-${agentId}`
        .replace(/[^A-Za-z0-9_-]/g, "-")
        .slice(0, 255);
      const orderResult = await telnyxRequest(
        `${TELNYX_BASE_URL}/number_orders`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: {
            phone_numbers: [{ phone_number: phoneNumber }],
            connection_id: connectionId,
            customer_reference: customerReference,
          },
        },
      );
      const order = orderResult?.data ?? orderResult;

      // order.phone_numbers[].id is a "number_order_phone_number" id, a
      // different resource/id space from the actual /v2/phone_numbers/{id}
      // record - it can never be used to tag or release the number. The
      // real phone-number resource (and its real id) only exists once the
      // order provisions, so always resolve it via a genuine lookup rather
      // than trusting anything on the order response itself.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt > 0) await sleep(250 * attempt);
        const provisioned = await getPhoneNumber({
          "filter[phone_number]": phoneNumber,
        });
        if (provisioned) {
          await tagNumber(provisioned.id, agentName);
          return {
            ...telnyxNumber(provisioned),
            telnyxOrderId: stringOrUndefined(order?.id),
          };
        }
      }
      throw new ProviderRequestError(
        "Telnyx",
        `Telnyx order ${order?.id ?? ""} is still provisioning`,
        { details: { orderId: order?.id, phoneNumber } },
      );
    },

    // Releases a number back to Telnyx (stops recurring per-number
    // billing) - used when an agent is permanently deleted, never on
    // disable.
    async releaseNumber(telnyxNumberId) {
      await telnyxRequest(
        `${TELNYX_BASE_URL}/phone_numbers/${encodeURIComponent(required(telnyxNumberId, "telnyxNumberId"))}`,
        { method: "DELETE" },
      );
    },
  };
}

export function createRetellClient({
  apiKey,
  terminationUri,
  sipTrunkAuthUsername,
  sipTrunkAuthPassword,
  transport = "TCP",
  fetchImpl = globalThis.fetch,
}) {
  requireCredential(apiKey, "Retell API key");

  const retellRequest = (path, options = {}) =>
    requestJson(fetchImpl, `${RETELL_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }, "Retell");

  const retellFormRequest = (path, form) =>
    requestJson(fetchImpl, `${RETELL_BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    }, "Retell");

  async function createLlm({ greeting, config }) {
    const result = await retellRequest("/create-retell-llm", {
      method: "POST",
      body: {
        start_speaker: config.startSpeaker === "user" ? "user" : "agent",
        begin_message: greeting,
        general_prompt: config.prompt,
        general_tools: config.tools,
        knowledge_base_ids: config.knowledgeBaseIds ?? [],
      },
    });
    return required(result?.llm_id, "Retell llm_id");
  }

  async function updateLlm(llmId, { greeting, config }) {
    await retellRequest(`/update-retell-llm/${encodeURIComponent(llmId)}`, {
      method: "PATCH",
      body: {
        start_speaker: config.startSpeaker === "user" ? "user" : "agent",
        begin_message: greeting,
        general_prompt: config.prompt,
        general_tools: config.tools,
        knowledge_base_ids: config.knowledgeBaseIds ?? [],
      },
    });
  }

  // A narrow companion to updateLlm - only touches knowledge_base_ids,
  // instead of resending the full prompt/greeting/tools every time. Used
  // when a Knowledge Base Hub edit needs to push a new content id to every
  // agent that references it, without paying for (or risking clobbering)
  // that agent's full config in the same request.
  async function updateLlmKnowledgeBaseIds(llmId, knowledgeBaseIds) {
    await retellRequest(`/update-retell-llm/${encodeURIComponent(llmId)}`, {
      method: "PATCH",
      body: { knowledge_base_ids: knowledgeBaseIds ?? [] },
    });
  }

  function agentBody({
    llmId,
    symanticAgentId,
    agentName,
    config,
  }) {
    return {
      response_engine: {
        type: "retell-llm",
        llm_id: llmId,
      },
      voice_id: config.voice,
      agent_name: `Symantic ${symanticAgentId} · ${agentName}`,
      // Explicit rather than relying on Retell's account-level default -
      // call_started is what makes an "ongoing" row show up in Call History
      // before the call ends; this guarantees it stays subscribed per agent
      // regardless of what the account-level webhook is configured to send.
      webhook_events: ["call_started", "call_ended", "call_analyzed"],
      ...(config.retellAgent ?? {}),
    };
  }

  return {
    async listVoices() {
      const voices = await retellRequest("/list-voices");
      return Array.isArray(voices) ? voices : [];
    },

    async createKnowledgeBase({ name, texts = [], files = [], urls = [], enableAutoRefresh = false }) {
      const form = new FormData();
      form.append("knowledge_base_name", required(name, "knowledgeBaseName").slice(0, 39));
      if (urls.length) form.append("knowledge_base_urls", JSON.stringify(urls));
      if (enableAutoRefresh) form.append("enable_auto_refresh", "true");
      // Pasted text goes through Retell's file mechanism too (as a synthetic
      // .txt file) rather than knowledge_base_texts, so every source in a
      // knowledge base's list looks and behaves the same way.
      const allFiles = [
        ...texts.map((entry, index) => ({
          name: `${(entry?.title || `pasted-text-${index + 1}`).replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`,
          contentType: "text/plain",
          data: new TextEncoder().encode(entry?.text ?? ""),
        })),
        ...files,
      ];
      for (const file of allFiles) {
        const blob = new Blob([file.data], {
          type: file.contentType || "application/octet-stream",
        });
        form.append("knowledge_base_files", blob, required(file.name, "knowledgeBaseFileName"));
      }
      const created = await retellFormRequest("/create-knowledge-base", form);
      return {
        knowledgeBaseId: required(created?.knowledge_base_id, "Retell knowledge_base_id"),
        status: stringOrUndefined(created?.status) ?? "in_progress",
      };
    },

    async deleteKnowledgeBase(knowledgeBaseId) {
      await retellRequest(`/delete-knowledge-base/${encodeURIComponent(required(knowledgeBaseId, "knowledgeBaseId"))}`, {
        method: "DELETE",
      });
    },

    updateLlmKnowledgeBaseIds,

    // Just the llm_id off an existing Retell agent - the one piece
    // updateLlmKnowledgeBaseIds needs, without the heavier lookups
    // upsertAgent does (symantic-id fallback search, agent body rebuild).
    // Null if the agent doesn't exist in Retell yet (never activated, or
    // was deleted there) - callers treat that as "nothing to push to".
    async getAgentLlmId(retellAgentId) {
      if (!retellAgentId) return null;
      try {
        const existing = await retellRequest(`/get-agent/${encodeURIComponent(retellAgentId)}`);
        return existing?.response_engine?.type === "retell-llm"
          ? existing.response_engine.llm_id ?? null
          : null;
      } catch (error) {
        if (error?.providerStatus === 404) return null;
        throw error;
      }
    },

    async upsertAgent({
      retellAgentId,
      symanticAgentId,
      agentName,
      greeting,
      config,
    }) {
      let existing = null;
      let resolvedId = typeof retellAgentId === "string" && retellAgentId
        ? retellAgentId
        : null;
      if (resolvedId) {
        try {
          existing = await retellRequest(
            `/get-agent/${encodeURIComponent(resolvedId)}`,
          );
        } catch (error) {
          if (error?.providerStatus !== 404) throw error;
        }
      }
      if (!existing) {
        existing = await findAgentBySymanticId(retellRequest, symanticAgentId);
        const listedId = existing?.agent_id ?? existing?.agentId;
        resolvedId = typeof listedId === "string" && listedId ? listedId : null;
      }

      if (existing && resolvedId) {
        const existingLlmId = existing?.response_engine?.type === "retell-llm"
          ? existing.response_engine.llm_id
          : null;
        const llmId = existingLlmId
          ? required(existingLlmId, "Retell llm_id")
          : await createLlm({ greeting, config });
        if (existingLlmId) await updateLlm(llmId, { greeting, config });
        await retellRequest(
          `/update-agent/${encodeURIComponent(resolvedId)}`,
          {
            method: "PATCH",
            body: agentBody({
              llmId,
              symanticAgentId,
              agentName,
              config,
            }),
          },
        );
        return { retellAgentId: resolvedId };
      }

      const llmId = await createLlm({ greeting, config });
      const created = await retellRequest("/create-agent", {
        method: "POST",
        body: agentBody({
          llmId,
          symanticAgentId,
          agentName,
          config,
        }),
      });
      return {
        retellAgentId: required(created?.agent_id, "Retell agent_id"),
      };
    },

    async importPhoneNumber({
      phoneNumber,
      retellAgentId,
      nickname,
      inboundWebhookUrl,
    }) {
      const result = await retellRequest("/import-phone-number", {
        method: "POST",
        body: {
          phone_number: required(phoneNumber, "phoneNumber"),
          termination_uri: required(
            terminationUri,
            "Telnyx termination URI",
          ),
          ...(sipTrunkAuthUsername
            ? { sip_trunk_auth_username: sipTrunkAuthUsername }
            : {}),
          ...(sipTrunkAuthPassword
            ? { sip_trunk_auth_password: sipTrunkAuthPassword }
            : {}),
          transport,
          inbound_agents: [{
            agent_id: required(retellAgentId, "retellAgentId"),
            weight: 1,
          }],
          outbound_agents: [{
            agent_id: required(retellAgentId, "retellAgentId"),
            weight: 1,
          }],
          ...(nickname ? { nickname } : {}),
          ...(inboundWebhookUrl
            ? { inbound_webhook_url: inboundWebhookUrl }
            : {}),
        },
      });
      return {
        retellPhoneNumberId: required(
          result?.phone_number,
          "Retell phone_number",
        ),
      };
    },

    // Restrict (or clear) which countries may call this number inbound. Retell
    // takes ISO 3166-1 alpha-2 codes; an empty list clears the restriction.
    async setPhoneNumberCountries(phoneNumber, { allowed_inbound_country_list }) {
      await retellRequest(
        `/update-phone-number/${encodeURIComponent(required(phoneNumber, "phoneNumber"))}`,
        {
          method: "PATCH",
          body: {
            allowed_inbound_country_list: Array.isArray(allowed_inbound_country_list)
              ? allowed_inbound_country_list
              : [],
          },
        },
      );
    },

    // Only ever called from the permanent agent-delete teardown, never
    // from disable. The agent's llm_id isn't persisted on our own side
    // (upsertAgent only ever returns retellAgentId - the llm is looked
    // up live via get-agent when needed), so this looks it up from
    // Retell right before tearing both down. Best-effort throughout -
    // the caller wraps this in .catch(() => {}), matching how
    // deleteKnowledgeBase is already used from the standalone KB-delete
    // route.
    async deleteAgentAndLlm(retellAgentId) {
      let llmId = null;
      try {
        const existing = await retellRequest(`/get-agent/${encodeURIComponent(required(retellAgentId, "retellAgentId"))}`);
        llmId = existing?.response_engine?.type === "retell-llm" ? existing.response_engine.llm_id : null;
      } catch {
        // Agent may already be gone or unreachable - still try the delete below.
      }
      await retellRequest(`/delete-agent/${encodeURIComponent(retellAgentId)}`, { method: "DELETE" });
      if (llmId) {
        await retellRequest(`/delete-retell-llm/${encodeURIComponent(llmId)}`, { method: "DELETE" });
      }
    },

    async deletePhoneNumber(phoneNumber) {
      await retellRequest(`/delete-phone-number/${encodeURIComponent(required(phoneNumber, "phoneNumber"))}`, {
        method: "DELETE",
      });
    },

    async startPhoneCall({
      fromNumber,
      toNumber,
      retellAgentId,
      workspaceId,
      agentId,
      currentTime,
      timezone,
    }) {
      const result = await retellRequest("/v2/create-phone-call", {
        method: "POST",
        body: {
          from_number: required(fromNumber, "fromNumber"),
          to_number: required(toNumber, "toNumber"),
          override_agent_id: required(retellAgentId, "retellAgentId"),
          metadata: {
            workspaceId,
            agentId,
            kind: "test",
          },
          retell_llm_dynamic_variables: {
            workspaceId,
            agentId,
            ...(currentTime ? { currentTime } : {}),
            ...(timezone ? { timezone } : {}),
          },
          ignore_e164_validation: true,
        },
      });
      return {
        callId: required(result?.call_id, "Retell call_id"),
        status: stringOrUndefined(result?.call_status) ?? "registered",
      };
    },
  };
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

// Per-million-token pricing (USD cents) for the models this feature is
// allowed to use - kept as an explicit table rather than trusting a single
// constant, since a cost misattribution here is a billing correctness bug,
// same class of risk as the minute-billing gate elsewhere in this file.
// Update if Anthropic's published pricing changes.
const ANTHROPIC_PRICING_CENTS_PER_MILLION_TOKENS = {
  "claude-haiku-4-5-20251001": { input: 80, output: 400 },
};

function anthropicCostCents(model, usage) {
  const pricing = ANTHROPIC_PRICING_CENTS_PER_MILLION_TOKENS[model];
  if (!pricing || !usage) return 0;
  const inputCost = (usage.input_tokens ?? 0) * pricing.input / 1_000_000;
  const outputCost = (usage.output_tokens ?? 0) * pricing.output / 1_000_000;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

export function createAnthropicClient({
  apiKey,
  model = "claude-haiku-4-5-20251001",
  fetchImpl = globalThis.fetch,
}) {
  requireCredential(apiKey, "Anthropic API key");

  return {
    // Clusters a batch of call summaries/transcript excerpts into the most
    // frequently asked questions/topics - a premium, on-demand digest, not
    // a per-call feature, so it's fine to spend a real LLM call on it.
    async summarizeMostAskedQuestions({ calls }) {
      const transcriptExcerpt = (call) => {
        if (Array.isArray(call.transcript) && call.transcript.length) {
          return call.transcript
            .filter((entry) => entry?.speaker && entry?.text)
            .slice(0, 20)
            .map((entry) => `${entry.speaker}: ${entry.text}`)
            .join("\n");
        }
        return call.callSummary ?? "";
      };
      const callBlocks = calls
        .map((call, index) => ({ index, excerpt: transcriptExcerpt(call).trim() }))
        .filter(({ excerpt }) => excerpt.length > 0)
        .map(({ index, excerpt }) => `Call ${index + 1}:\n${excerpt}`)
        .join("\n\n---\n\n");

      const prompt = `Below are excerpts from ${calls.length} customer phone calls to a small business's AI receptionist. Identify the most frequently asked questions or topics across these calls.

Respond with ONLY a JSON array (no prose, no markdown fences) of up to 25 objects, ranked by frequency, each shaped as:
{"question": "a clear, generalized version of the question", "count": <number of calls that asked something like this>, "exampleQuote": "a short representative quote from one call", "suggestedKnowledgeBaseAddition": "one sentence suggesting what content to add to the knowledge base to answer this automatically"}

Calls:
${callBlocks}`;

      const body = await requestJson(fetchImpl, ANTHROPIC_BASE_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        }),
      }, "Anthropic");

      const text = body?.content?.find((block) => block?.type === "text")?.text ?? "[]";
      let questions;
      try {
        const parsed = JSON.parse(text.trim().replace(/^```json\s*|```$/g, ""));
        questions = Array.isArray(parsed) ? parsed : [];
      } catch {
        questions = [];
      }

      return {
        questions: questions
          .filter((entry) => entry && typeof entry.question === "string")
          .map((entry) => ({
            question: entry.question,
            count: Number.isFinite(entry.count) ? entry.count : 0,
            exampleQuote: typeof entry.exampleQuote === "string" ? entry.exampleQuote : "",
            suggestedKnowledgeBaseAddition:
              typeof entry.suggestedKnowledgeBaseAddition === "string" ? entry.suggestedKnowledgeBaseAddition : "",
          })),
        model,
        usage: {
          inputTokens: body?.usage?.input_tokens ?? 0,
          outputTokens: body?.usage?.output_tokens ?? 0,
        },
        costCents: anthropicCostCents(model, body?.usage),
      };
    },
  };
}

export function resolveRetellVoiceId(requestedVoice, settings) {
  const mapped = settings?.voiceIds?.[requestedVoice];
  if (typeof mapped === "string" && mapped) return mapped;
  if (
    typeof requestedVoice === "string" &&
    /^(?:retell|11labs|openai|cartesia|playht|minimax|fish|azure)-/i
      .test(requestedVoice)
  ) {
    return requestedVoice;
  }
  if (typeof settings?.defaultVoiceId === "string" && settings.defaultVoiceId) {
    return settings.defaultVoiceId;
  }
  throw new ProviderRequestError(
    "Retell",
    "Retell secret must contain defaultVoiceId or a voiceIds mapping",
  );
}

async function requestJson(fetchImpl, url, init, provider) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ProviderRequestError(
      provider,
      `${provider} request failed: ${error?.message ?? "network error"}`,
      { details: { cause: error?.message } },
    );
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep a null body for non-JSON provider errors.
  }
  if (!response.ok) {
    const providerMessage = body?.errors?.[0]?.detail ??
      body?.message ??
      body?.error_message;
    throw new ProviderRequestError(
      provider,
      providerMessage || `${provider} request failed (${response.status})`,
      {
        providerStatus: response.status,
        details: body,
      },
    );
  }
  return body;
}

function normalizeE164ForTelnyx(phoneNumber) {
  const digits = String(phoneNumber ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function northAmericanAreaCode(phoneNumber) {
  const digits = String(phoneNumber ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

function telnyxNumber(value) {
  return {
    telnyxNumberId: value.id,
    telnyxPhoneNumber: value.phone_number,
  };
}

function isProvisionedNumber(value) {
  return typeof value?.id === "string" &&
    value.id.length > 0 &&
    typeof value?.phone_number === "string" &&
    value.phone_number.length > 0;
}

function required(value, field) {
  if (typeof value !== "string" || !value) {
    throw new ProviderRequestError("provider", `${field} is required`);
  }
  return value;
}

function requireCredential(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required`);
  }
}

function stringOrUndefined(value) {
  return typeof value === "string" && value ? value : undefined;
}

function isSymanticAgentName(agentName, symanticAgentId) {
  if (typeof agentName !== "string" || !agentName) return false;
  return agentName === `Symantic ${symanticAgentId}` ||
    agentName.startsWith(`Symantic ${symanticAgentId} ·`);
}

async function findAgentBySymanticId(retellRequest, symanticAgentId) {
  const listed = await retellRequest("/v2/list-agents?limit=1000", {
    method: "POST",
    body: {
      filter_criteria: {
        channel: { type: "string", op: "eq", value: "voice" },
      },
    },
  });
  const agents = Array.isArray(listed) ? listed : listed?.items ?? listed?.agents ?? [];
  return agents.find((candidate) =>
    isSymanticAgentName(candidate?.agent_name, symanticAgentId)
  ) ?? null;
}
