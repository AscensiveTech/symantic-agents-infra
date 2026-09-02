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

  return {
    async ensureNumber({
      workspaceId,
      agentId,
      preferredPhone,
    }) {
      const customerReference = `${required(workspaceId, "workspaceId")}:${
        required(agentId, "agentId")
      }`;
      const owned = await getPhoneNumber({
        "filter[customer_reference]": customerReference,
      });
      if (owned) return telnyxNumber(owned);

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
      const phoneNumber = availableResult?.data?.[0]?.phone_number;
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
      const orderedNumber = order?.phone_numbers?.find(
        (candidate) => candidate?.phone_number === phoneNumber,
      ) ?? order?.phone_numbers?.[0];
      if (isProvisionedNumber(orderedNumber)) {
        return {
          ...telnyxNumber(orderedNumber),
          telnyxOrderId: stringOrUndefined(order?.id),
        };
      }

      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt > 0) await sleep(250 * attempt);
        const provisioned = await getPhoneNumber({
          "filter[phone_number]": phoneNumber,
        });
        if (provisioned) {
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

  async function createLlm({ greeting, config }) {
    const result = await retellRequest("/create-retell-llm", {
      method: "POST",
      body: {
        begin_message: greeting,
        general_prompt: config.prompt,
        general_tools: config.tools,
      },
    });
    return required(result?.llm_id, "Retell llm_id");
  }

  async function updateLlm(llmId, { greeting, config }) {
    await retellRequest(`/update-retell-llm/${encodeURIComponent(llmId)}`, {
      method: "PATCH",
      body: {
        begin_message: greeting,
        general_prompt: config.prompt,
        general_tools: config.tools,
      },
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
      ...(config.retellAgent ?? {}),
    };
  }

  return {
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
  const listed = await retellRequest("/list-agents");
  const agents = Array.isArray(listed) ? listed : listed?.agents ?? [];
  return agents.find((candidate) =>
    isSymanticAgentName(candidate?.agent_name, symanticAgentId)
  ) ?? null;
}
