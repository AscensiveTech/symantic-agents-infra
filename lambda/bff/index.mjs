import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createRetellClient,
  createTelnyxClient,
  ProviderRequestError,
  resolveRetellVoiceId,
} from "./providers.mjs";
import { buildReceptionistConfig } from "./receptionist.mjs";

const PROFILE_FIELDS = {
  businessType: "string",
  businessName: "string",
  address: "string",
  timezone: "string",
  phone: "string",
  description: "string",
  hours: "string",
  services: "string[]",
  faqs: "faq[]",
  policies: "string",
  escalationContact: "string",
  ownerPhone: "string",
  fallbackPhone: "string",
  communicationStyle: "string",
};

const AGENT_STATUSES = new Set(["active", "draft", "preview", "planned"]);
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function readBody(event) {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(PROFILE_FIELDS).every(([field, kind]) => {
    const candidate = value[field];
    if (kind === "string") return typeof candidate === "string";
    if (kind === "string[]") {
      return Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
    }
    return Array.isArray(candidate) && candidate.every((item) => (
      item &&
      typeof item === "object" &&
      typeof item.question === "string" &&
      typeof item.answer === "string"
    ));
  });
}

function pickProfile(value) {
  return Object.fromEntries(Object.keys(PROFILE_FIELDS).map((field) => [field, value[field]]));
}

function pickAgent(value, routeAgentId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const agentId = routeAgentId ?? value.id ?? value.agentId;
  if (
    typeof agentId !== "string" ||
    !AGENT_ID_PATTERN.test(agentId) ||
    (value.id !== undefined && value.id !== agentId) ||
    (value.agentId !== undefined && value.agentId !== agentId) ||
    typeof value.name !== "string" ||
    typeof value.role !== "string" ||
    typeof value.description !== "string" ||
    !AGENT_STATUSES.has(value.status) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string") ||
    (value.configuration !== undefined && (
      !value.configuration ||
      typeof value.configuration !== "object" ||
      Array.isArray(value.configuration)
    ))
  ) {
    return null;
  }
  return {
    id: agentId,
    name: value.name,
    role: value.role,
    description: value.description,
    status: value.status,
    capabilities: value.capabilities,
    ...(value.configuration === undefined ? {} : { configuration: value.configuration }),
  };
}

function getAgentId(event, path) {
  const value = event?.pathParameters?.agentId ?? path.match(/^\/workspaces\/me\/agents\/([^/]+)$/)?.[1];
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return AGENT_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function getAgentAction(event, path) {
  const match = path.match(
    /^\/workspaces\/me\/agents\/([^/]+)\/(activate|start-test-call)$/,
  );
  if (!match) return null;
  try {
    const agentId = decodeURIComponent(
      event?.pathParameters?.agentId ?? match[1],
    );
    return AGENT_ID_PATTERN.test(agentId)
      ? { agentId, action: match[2] }
      : null;
  } catch {
    return null;
  }
}

export function createHandler({
  getStore = getDefaultStore,
  getProviders = getDefaultProviders,
  getRetellApiKey = getDefaultRetellApiKey,
  verifySignature = verifyRetellSignature,
  toolBaseUrl = process.env.PUBLIC_API_BASE_URL,
} = {}) {
  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path;
    try {
      if (path === "/retell/inbound-lookup" && method === "POST") {
        return await handleInboundLookup(event, {
          getStore,
          getProviders,
          getRetellApiKey,
          verifySignature,
          toolBaseUrl,
        });
      }

      const workspaceId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        return json(401, { message: "Unauthorized" });
      }

      if (path === "/workspaces/me/profile" && method === "PUT") {
        const body = readBody(event);
        if (!isProfile(body)) return json(400, { message: "Invalid profile" });
        const profile = pickProfile(body);
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const saved = await store.putProfile(workspaceId, profile);
        return json(200, saved);
      }

      if (path === "/workspaces/me/profile" && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        return json(200, await store.getProfile(workspaceId));
      }

      if (path === "/workspaces/me/agents" && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        return json(200, await store.listAgents(workspaceId));
      }

      if (path === "/workspaces/me/agents" && method === "POST") {
        const agent = pickAgent(readBody(event));
        if (!agent) return json(400, { message: "Invalid agent" });
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        return json(201, await store.createAgent(workspaceId, agent.id, agent));
      }

      const agentAction = getAgentAction(event, path);
      if (agentAction?.action === "activate" && method === "POST") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentAction.agentId);
        if (!agent) return json(404, { message: "Agent not found" });
        const profile = await store.getProfile(workspaceId);
        if (!profile) {
          return json(409, {
            message: "Complete the business profile before activation",
          });
        }
        const providers = await getProviders();
        let phoneNumber = await store.getPhoneNumberForAgent(
          workspaceId,
          agentAction.agentId,
        );
        if (!phoneNumber) {
          const provisioned = await providers.telnyx.ensureNumber({
            workspaceId,
            agentId: agentAction.agentId,
            preferredPhone: agent?.configuration?.phone ?? profile.phone,
          });
          phoneNumber = {
            workspaceId,
            phoneNumberId: `phone-${agentAction.agentId}`,
            agentId: agentAction.agentId,
            ...provisioned,
            status: "active",
            createdAt: new Date().toISOString(),
          };
          await store.putPhoneNumber(phoneNumber);
        }
        const voiceId = providers.resolveVoiceId(
          agent?.configuration?.voice,
        );
        const config = buildReceptionistConfig({
          workspaceId,
          agent,
          profile,
          toolBaseUrl,
          voiceId,
        });
        const synced = await providers.retell.upsertAgent({
          retellAgentId: agent.retellAgentId,
          symanticAgentId: agentAction.agentId,
          agentName: agent?.configuration?.name ?? agent.name,
          greeting: agent?.configuration?.greeting ?? "",
          config,
        });
        try {
          await store.updateAgentRuntime(
            workspaceId,
            agentAction.agentId,
            { retellAgentId: synced.retellAgentId },
          );
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return json(404, { message: "Agent not found" });
          }
          console.error("Failed to persist retellAgentId after Retell upsert", error);
        }
        const activatedAt = new Date().toISOString();
        let updatedAgent;
        try {
          updatedAgent = await store.updateAgentRuntime(
            workspaceId,
            agentAction.agentId,
            {
              status: "active",
              retellAgentId: synced.retellAgentId,
              activatedAt,
              updatedAt: activatedAt,
            },
          );
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return json(404, { message: "Agent not found" });
          }
          throw error;
        }
        return json(200, {
          agent: toPublicAgent(updatedAgent),
          phoneNumber: toPublicPhoneNumber(phoneNumber),
        });
      }

      if (agentAction?.action === "start-test-call" && method === "POST") {
        const body = readBody(event);
        const toNumber = body?.toNumber;
        if (!isE164(toNumber)) {
          return json(400, {
            message: "toNumber must be an E.164 phone number",
          });
        }
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentAction.agentId);
        if (!agent) return json(404, { message: "Agent not found" });
        const phoneNumber = await store.getPhoneNumberForAgent(
          workspaceId,
          agentAction.agentId,
        );
        if (!agent.retellAgentId || !phoneNumber?.telnyxPhoneNumber) {
          return json(409, {
            message: "Activate the agent before starting a test call",
          });
        }
        const providers = await getProviders();
        const call = await providers.retell.startPhoneCall({
          fromNumber: phoneNumber.telnyxPhoneNumber,
          toNumber,
          retellAgentId: agent.retellAgentId,
          workspaceId,
          agentId: agentAction.agentId,
        });
        return json(202, call);
      }

      const agentId = getAgentId(event, path);
      if (agentId && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentId);
        return agent
          ? json(200, toPublicAgent(agent))
          : json(404, { message: "Agent not found" });
      }

      if (agentId && method === "PUT") {
        const agent = pickAgent(readBody(event), agentId);
        if (!agent) return json(400, { message: "Invalid agent" });
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        try {
          return json(200, await store.putAgent(workspaceId, agentId, agent));
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return json(404, { message: "Agent not found" });
          }
          throw error;
        }
      }

      return json(404, { message: "Not found" });
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return json(409, { message: "Agent already exists" });
      }
      if (error instanceof ProviderRequestError) {
        console.error("BFF provider request failed", {
          provider: error.provider,
          providerStatus: error.providerStatus,
          message: error.message,
        });
        return json(502, { message: error.message });
      }
      console.error("BFF request failed", error);
      return json(500, { message: "Internal server error" });
    }
  };
}

async function handleInboundLookup(event, {
  getStore,
  getProviders,
  getRetellApiKey,
  verifySignature,
  toolBaseUrl,
}) {
  const rawBody = readRawBody(event);
  const signature = readHeader(event?.headers, "x-retell-signature");
  if (rawBody === null || !signature) {
    return json(401, { message: "Unauthorized" });
  }
  const apiKey = await getRetellApiKey();
  if (!await verifySignature(rawBody, apiKey, signature)) {
    return json(401, { message: "Unauthorized" });
  }
  let input;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }
  const did = input?.to_number ??
    input?.toNumber ??
    input?.did ??
    input?.phone_number ??
    input?.phoneNumber;
  if (!isE164(did)) {
    return json(400, { message: "An E.164 destination DID is required" });
  }

  const store = await getStore();
  const phoneNumber = await store.getPhoneNumberByDid(did);
  if (!phoneNumber) return json(404, { message: "Phone number not found" });
  const [agent, profile] = await Promise.all([
    store.getAgent(phoneNumber.workspaceId, phoneNumber.agentId),
    store.getProfile(phoneNumber.workspaceId),
  ]);
  if (!agent || !profile) {
    return json(404, { message: "Receptionist configuration not found" });
  }
  const providers = await getProviders();
  const config = buildReceptionistConfig({
    workspaceId: phoneNumber.workspaceId,
    agent,
    profile,
    toolBaseUrl,
    voiceId: providers.resolveVoiceId(agent?.configuration?.voice),
  });
  return json(200, config);
}

export function verifyRetellSignature(
  rawBody,
  apiKey,
  signature,
  { now = Date.now, timeoutMs = 5 * 60_000 } = {},
) {
  if (
    typeof rawBody !== "string" ||
    typeof apiKey !== "string" ||
    !apiKey ||
    typeof signature !== "string"
  ) {
    return false;
  }
  const match = signature.match(/^v=(\d+),d=([a-f0-9]{64})$/i);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Number(now()) - timestamp) > timeoutMs
  ) {
    return false;
  }
  const expected = createHmac("sha256", apiKey)
    .update(rawBody + match[1])
    .digest();
  const provided = Buffer.from(match[2], "hex");
  return provided.length === expected.length &&
    timingSafeEqual(provided, expected);
}

function readRawBody(event) {
  if (typeof event?.body !== "string") return null;
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function isE164(value) {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
}

function isConditionalCheckFailed(error) {
  return error?.name === "ConditionalCheckFailedException";
}

function toAttributeValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  if (typeof value === "object") {
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, toAttributeValue(item)]),
      ),
    };
  }
  throw new TypeError(`Unsupported DynamoDB value: ${typeof value}`);
}

function marshall(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toAttributeValue(item)]),
  );
}

function fromAttributeValue(value) {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.L) return value.L.map(fromAttributeValue);
  if (value.M) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, item]) => [key, fromAttributeValue(item)]),
    );
  }
  return undefined;
}

function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}

function toAgentRecord(item) {
  if (!item) return null;
  const { workspaceId: _workspaceId, agentId, ...agent } = item;
  return { id: agentId, ...agent };
}

function toPublicAgent(item) {
  if (!item) return null;
  const {
    workspaceId: _workspaceId,
    agentId,
    retellAgentId: _retellAgentId,
    retellLlmId: _retellLlmId,
    telnyxNumberId: _telnyxNumberId,
    telnyxPhoneNumber: _telnyxPhoneNumber,
    ...agent
  } = item;
  return { id: agentId, ...agent };
}

function toPublicPhoneNumber(item) {
  return {
    id: item.phoneNumberId,
    agentId: item.agentId,
    phoneNumber: item.telnyxPhoneNumber,
    status: item.status,
  };
}

export function createDynamoStore(client, commands, tableNames) {
  return {
    async ensureWorkspace(workspaceId) {
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.workspaces,
        Key: marshall({ workspaceId }),
        UpdateExpression: "SET createdAt = if_not_exists(createdAt, :createdAt)",
        ExpressionAttributeValues: marshall({ ":createdAt": new Date().toISOString() }),
      }));
    },

    async getProfile(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.businessProfiles,
        Key: marshall({ workspaceId }),
        ConsistentRead: true,
      }));
      if (!result.Item) return null;
      const { workspaceId: _workspaceId, ...profile } = unmarshall(result.Item);
      return profile;
    },

    async putProfile(workspaceId, profile) {
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.businessProfiles,
        Item: marshall({ workspaceId, ...profile }),
      }));
      return profile;
    },

    async listAgents(workspaceId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.agents,
        KeyConditionExpression: "workspaceId = :workspaceId",
        ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        ConsistentRead: true,
      }));
      return (result.Items ?? []).map((item) => toPublicAgent(unmarshall(item)));
    },

    async getAgent(workspaceId, agentId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        ConsistentRead: true,
      }));
      return result.Item ? toAgentRecord(unmarshall(result.Item)) : null;
    },

    async createAgent(workspaceId, agentId, agent) {
      const { id: _id, ...record } = agent;
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.agents,
        Item: marshall({ workspaceId, agentId, ...record }),
        ConditionExpression: "attribute_not_exists(agentId)",
      }));
      return agent;
    },

    async putAgent(workspaceId, agentId, agent) {
      const { id: _id, ...record } = agent;
      const entries = Object.entries(record)
        .filter(([, value]) => value !== undefined);
      const names = Object.fromEntries(
        entries.map(([field], index) => [`#field${index}`, field]),
      );
      const values = Object.fromEntries(
        entries.map(([, value], index) => [`:value${index}`, value]),
      );
      await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        UpdateExpression: `SET ${
          entries.map(
            (_entry, index) => `#field${index} = :value${index}`,
          ).join(", ")
        }`,
        ConditionExpression: "attribute_exists(agentId)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
      }));
      return agent;
    },

    async updateAgentRuntime(workspaceId, agentId, updates) {
      const entries = Object.entries(updates)
        .filter(([, value]) => value !== undefined);
      const names = Object.fromEntries(
        entries.map(([field], index) => [`#field${index}`, field]),
      );
      const values = Object.fromEntries(
        entries.map(([, value], index) => [`:value${index}`, value]),
      );
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableNames.agents,
        Key: marshall({ workspaceId, agentId }),
        UpdateExpression: `SET ${
          entries.map(
            (_entry, index) => `#field${index} = :value${index}`,
          ).join(", ")
        }`,
        ConditionExpression: "attribute_exists(agentId)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
        ReturnValues: "ALL_NEW",
      }));
      return toAgentRecord(unmarshall(result.Attributes));
    },

    async getPhoneNumberForAgent(workspaceId, agentId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableNames.phoneNumbers,
        Key: marshall({
          workspaceId,
          phoneNumberId: `phone-${agentId}`,
        }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },

    async putPhoneNumber(record) {
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.phoneNumbers,
        Item: marshall(record),
      }));
      return record;
    },

    async getPhoneNumberByDid(telnyxPhoneNumber) {
      const result = await client.send(new commands.QueryCommand({
        TableName: tableNames.phoneNumbers,
        IndexName: "telnyxPhoneNumber-index",
        KeyConditionExpression: "telnyxPhoneNumber = :phoneNumber",
        ExpressionAttributeValues: marshall({
          ":phoneNumber": telnyxPhoneNumber,
        }),
        Limit: 1,
      }));
      return result.Items?.[0] ? unmarshall(result.Items[0]) : null;
    },
  };
}

let storePromise;

async function getDefaultStore() {
  storePromise ??= import("@aws-sdk/client-dynamodb").then((commands) => {
    const tableNames = {
      workspaces: process.env.WORKSPACES_TABLE,
      businessProfiles: process.env.BUSINESS_PROFILES_TABLE,
      agents: process.env.AGENTS_TABLE,
      phoneNumbers: process.env.PHONE_NUMBERS_TABLE,
    };
    if (Object.values(tableNames).some((value) => !value)) {
      throw new Error("BFF DynamoDB table environment variables are required");
    }
    return createDynamoStore(new commands.DynamoDBClient({}), commands, tableNames);
  });
  return storePromise;
}

const secretPromises = new Map();

async function getProviderSecret(secretArn, provider) {
  if (!secretArn) throw new Error(`${provider} secret ARN is required`);
  if (!secretPromises.has(secretArn)) {
    secretPromises.set(
      secretArn,
      import("@aws-sdk/client-secrets-manager").then(async (commands) => {
        const client = new commands.SecretsManagerClient({});
        const result = await client.send(new commands.GetSecretValueCommand({
          SecretId: secretArn,
        }));
        if (!result.SecretString) {
          throw new Error(`${provider} secret string is empty`);
        }
        try {
          return JSON.parse(result.SecretString);
        } catch {
          throw new Error(`${provider} secret must contain JSON`);
        }
      }),
    );
  }
  return secretPromises.get(secretArn);
}

function readApiKey(secret, provider) {
  const apiKey = secret?.apiKey ??
    secret?.api_key ??
    secret?.[`${provider.toLowerCase()}ApiKey`];
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error(`${provider} secret must contain apiKey`);
  }
  return apiKey;
}

async function getDefaultRetellApiKey() {
  const secret = await getProviderSecret(
    process.env.RETELL_SECRET_ARN,
    "Retell",
  );
  return readApiKey(secret, "Retell");
}

let providersPromise;
async function getDefaultProviders() {
  providersPromise ??= Promise.all([
    getProviderSecret(process.env.RETELL_SECRET_ARN, "Retell"),
    getProviderSecret(process.env.TELNYX_SECRET_ARN, "Telnyx"),
  ]).then(([retellSecret, telnyxSecret]) => ({
    retell: createRetellClient({
      apiKey: readApiKey(retellSecret, "Retell"),
    }),
    telnyx: createTelnyxClient({
      apiKey: readApiKey(telnyxSecret, "Telnyx"),
      connectionId: telnyxSecret.connectionId ??
        telnyxSecret.connection_id ??
        telnyxSecret.telnyxConnectionId,
    }),
    resolveVoiceId: (requestedVoice) =>
      resolveRetellVoiceId(requestedVoice, {
        defaultVoiceId: retellSecret.defaultVoiceId ??
          retellSecret.default_voice_id,
        voiceIds: retellSecret.voiceIds ?? retellSecret.voice_ids,
      }),
  }));
  return providersPromise;
}

export const handler = createHandler();
