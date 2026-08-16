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

export function createHandler({ getStore }) {
  return async function handle(event) {
    const workspaceId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return json(401, { message: "Unauthorized" });
    }

    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path;
    try {
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
        return json(201, await store.putAgent(workspaceId, agent.id, agent));
      }

      const agentId = getAgentId(event, path);
      if (agentId && method === "GET") {
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        const agent = await store.getAgent(workspaceId, agentId);
        return agent ? json(200, agent) : json(404, { message: "Agent not found" });
      }

      if (agentId && method === "PUT") {
        const agent = pickAgent(readBody(event), agentId);
        if (!agent) return json(400, { message: "Invalid agent" });
        const store = await getStore();
        await store.ensureWorkspace(workspaceId);
        return json(200, await store.putAgent(workspaceId, agentId, agent));
      }

      return json(404, { message: "Not found" });
    } catch (error) {
      console.error("BFF request failed", error);
      return json(500, { message: "Internal server error" });
    }
  };
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

function toPublicAgent(item) {
  if (!item) return null;
  const { workspaceId: _workspaceId, agentId, ...agent } = item;
  return { id: agentId, ...agent };
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
      return result.Item ? toPublicAgent(unmarshall(result.Item)) : null;
    },

    async putAgent(workspaceId, agentId, agent) {
      const { id: _id, ...record } = agent;
      await client.send(new commands.PutItemCommand({
        TableName: tableNames.agents,
        Item: marshall({ workspaceId, agentId, ...record }),
      }));
      return agent;
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
    };
    if (Object.values(tableNames).some((value) => !value)) {
      throw new Error("BFF DynamoDB table environment variables are required");
    }
    return createDynamoStore(new commands.DynamoDBClient({}), commands, tableNames);
  });
  return storePromise;
}

export const handler = createHandler({ getStore: getDefaultStore });
