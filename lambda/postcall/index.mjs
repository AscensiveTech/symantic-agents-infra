import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ROUTE = "/retell/webhooks/call-ended";
const MAX_CALL_CONTENT_BYTES = 340 * 1024;

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

export function createHandler({
  verifySignature = verifyRetellSignature,
  getRetellApiKey = getDefaultRetellApiKey,
  getStore = getDefaultStore,
  now = () => new Date(),
} = {}) {
  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
    if (method !== "POST" || path !== ROUTE) {
      return json(404, { message: "Not found" });
    }

    const rawBody = readRawBody(event);
    const signature = readHeader(event?.headers, "x-retell-signature");
    if (rawBody === null || !signature) {
      return json(401, { message: "Unauthorized" });
    }
    try {
      const apiKey = await getRetellApiKey();
      if (!await verifySignature(rawBody, apiKey, signature)) {
        return json(401, { message: "Unauthorized" });
      }
    } catch (error) {
      console.error("Retell signature verification failed", {
        name: error?.name,
        message: error?.message,
      });
      return json(500, { message: "Request verification is unavailable." });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { message: "Invalid JSON body" });
    }
    const call = payload?.event === "call_ended" ? payload.call : null;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      return json(400, { message: "A call_ended payload is required" });
    }

    const toolLog = normalizeToolLog(call.transcript_with_tool_calls);
    let workspaceId = callContextValue(call, toolLog, "workspaceId");
    const retellCallId = stringValue(call.call_id);
    let agentId = callContextValue(call, toolLog, "agentId");
    let store;
    if (!workspaceId && stringValue(call.agent_id)) {
      try {
        store = await getStore();
        const linkedAgent = await store.findAgentByRetellAgentId(call.agent_id);
        workspaceId = stringValue(linkedAgent?.workspaceId);
        agentId = stringValue(linkedAgent?.agentId) ?? agentId;
      } catch (error) {
        console.error("Retell agent lookup failed", {
          name: error?.name,
          message: error?.message,
        });
        return json(500, { message: "Post-call agent lookup failed" });
      }
    }
    if (!workspaceId || !retellCallId) {
      return json(400, { message: "workspaceId and call.call_id are required" });
    }
    const timestamp = new Date(now()).toISOString();
    const callId = stableId("call", workspaceId, retellCallId);
    const summary = summarizeCall(call, toolLog);
    const content = truncateCallContent(
      normalizeTranscript(call.transcript_object, call.transcript),
      toolLog,
    );
    const record = {
      workspaceId,
      callId,
      retellCallId,
      agentId,
      direction: stringValue(call.direction),
      callerNumber: callerNumber(call),
      callerName: summary.callerName,
      intent: summary.intent,
      startedAt: timestampValue(call.start_timestamp),
      endedAt: timestampValue(call.end_timestamp),
      durationMs: durationMs(call),
      recordingUrl: stringValue(call.recording_url),
      disconnectionReason: stringValue(call.disconnection_reason),
      transcript: content.transcript,
      toolLog: content.toolLog,
      ...(content.truncated
        ? {
          transcriptTruncated: true,
          transcriptNote:
            "Transcript and tool log were truncated to stay within the Calls item size limit.",
        }
        : {}),
      outcome: inferOutcome(call, toolLog),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      store ??= await getStore();
      await store.putCall(record);
      await backfillToolRecords(store, { ...record, toolLog });
      if (
        call?.metadata?.kind === "test" &&
        agentId &&
        isSuccessfulTestOutcome(record.outcome) &&
        typeof store.markAgentTested === "function"
      ) {
        await store.markAgentTested(workspaceId, agentId, timestamp);
      }
      return noContent();
    } catch (error) {
      console.error("Post-call ingest failed", {
        name: error?.name,
        message: error?.message,
        workspaceId,
        callId,
      });
      return json(500, { message: "Post-call ingest failed" });
    }
  };
}

function normalizeToolLog(value) {
  return Array.isArray(value)
    ? value.filter((entry) =>
      entry &&
      typeof entry === "object" &&
      ["tool_call_invocation", "tool_call_result"].includes(entry.role)
    )
    : [];
}

function truncateCallContent(transcript, toolLog) {
  if (callContentBytes(transcript, toolLog) <= MAX_CALL_CONTENT_BYTES) {
    return { transcript, toolLog, truncated: false };
  }
  const limitedTranscript = transcript.map((entry) => ({
    ...entry,
    text: truncateString(entry.text, 16_000),
  }));
  const limitedToolLog = toolLog.map((entry) =>
    Object.fromEntries(Object.entries(entry).map(([key, value]) => [
      key,
      typeof value === "string" ? truncateString(value, 16_000) : value,
    ]))
  );
  while (
    limitedTranscript.length &&
    callContentBytes(limitedTranscript, limitedToolLog) > MAX_CALL_CONTENT_BYTES
  ) {
    limitedTranscript.pop();
  }
  while (
    limitedToolLog.length &&
    callContentBytes(limitedTranscript, limitedToolLog) > MAX_CALL_CONTENT_BYTES
  ) {
    limitedToolLog.pop();
  }
  return {
    transcript: limitedTranscript,
    toolLog: limitedToolLog,
    truncated: true,
  };
}

function callContentBytes(transcript, toolLog) {
  return Buffer.byteLength(JSON.stringify({ transcript, toolLog }), "utf8");
}

function truncateString(value, maxLength) {
  return typeof value === "string" && value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
}

function toolActions(toolLog) {
  const results = new Map(
    toolLog
      .filter((entry) => entry.role === "tool_call_result")
      .map((entry) => [entry.tool_call_id, entry]),
  );
  return toolLog
    .filter((entry) => entry.role === "tool_call_invocation")
    .map((invocation) => {
      const result = results.get(invocation.tool_call_id);
      const output = parseObject(result?.content) ?? {};
      return {
        name: stringValue(invocation.name),
        arguments: parseObject(invocation.arguments) ?? {},
        output,
        successful: result?.successful !== false && output.ok !== false,
      };
    });
}

async function backfillToolRecords(store, call) {
  for (const action of toolActions(call.toolLog)) {
    if (!action.successful) continue;
    const args = action.arguments;
    const output = action.output;
    const common = {
      workspaceId: call.workspaceId,
      callId: call.callId,
      retellCallId: call.retellCallId,
      agentId: stringValue(args.agentId) ?? call.agentId,
      idempotencyKey: stringValue(args.idempotencyKey),
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
    };
    if (
      action.name === "calendar_create_booking" &&
      typeof store.upsertAppointment === "function"
    ) {
      await store.upsertAppointment({
        ...common,
        appointmentId: stringValue(output.appointmentId) ??
          stableId(
            "apt",
            call.workspaceId,
            common.idempotencyKey ?? `${call.retellCallId}-booking`,
          ),
        service: stringValue(args.service) ?? "Appointment",
        customer: normalizeContact(args.customer),
        startTimeUtc: stringValue(output.startTimeUtc),
        endTimeUtc: stringValue(output.endTimeUtc),
        timezone: stringValue(output.timezone),
        status: stringValue(output.status) ?? "confirmed",
      });
    } else if (
      action.name === "lead_capture" &&
      typeof store.upsertLead === "function"
    ) {
      await store.upsertLead({
        ...common,
        leadId: stringValue(output.leadId) ??
          stableId(
            "lead",
            call.workspaceId,
            common.idempotencyKey ?? `${call.retellCallId}-lead`,
          ),
        ...normalizeContact(args),
        interest: stringValue(args.interest),
        notes: stringValue(args.notes),
        status: stringValue(output.status) ?? "captured",
        notifyStatus: "pending",
      });
    } else if (
      action.name === "message_take" &&
      typeof store.upsertMessage === "function"
    ) {
      await store.upsertMessage({
        ...common,
        messageId: stringValue(output.messageId) ??
          stableId(
            "msg",
            call.workspaceId,
            common.idempotencyKey ?? `${call.retellCallId}-message`,
          ),
        ...normalizeContact(args),
        message: stringValue(args.message),
        urgency: stringValue(args.urgency),
        status: stringValue(output.status) ?? "received",
        notifyStatus: "pending",
      });
    }
  }
}

function callContextValue(call, toolLog, field) {
  const direct = stringValue(call?.metadata?.[field]) ||
    stringValue(call?.retell_llm_dynamic_variables?.[field]);
  if (direct) return direct;
  for (const entry of toolLog) {
    if (entry.role !== "tool_call_invocation") continue;
    const args = parseObject(entry.arguments);
    const value = stringValue(args?.[field]);
    if (value) return value;
  }
  return undefined;
}

function summarizeCall(call, toolLog) {
  const actions = toolActions(toolLog);
  const callerName = [
    call?.metadata?.callerName,
    call?.metadata?.customerName,
    call?.retell_llm_dynamic_variables?.callerName,
    call?.retell_llm_dynamic_variables?.customer_name,
    call?.collected_dynamic_variables?.callerName,
    call?.collected_dynamic_variables?.customer_name,
    ...actions.flatMap(({ arguments: args }) => [
      args?.customer?.name,
      args?.name,
    ]),
  ].map(stringValue).find(Boolean);
  const intent = [
    call?.metadata?.intent,
    call?.retell_llm_dynamic_variables?.intent,
    call?.collected_dynamic_variables?.intent,
    ...actions.flatMap(({ arguments: args }) => [
      args?.service,
      args?.interest,
      args?.reason,
    ]),
  ].map(stringValue).find(Boolean);
  return { callerName, intent };
}

function normalizeTranscript(value, fallback) {
  if (Array.isArray(value)) {
    const transcript = value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const text = stringValue(entry.content);
      if (!text) return [];
      const words = Array.isArray(entry.words) ? entry.words : [];
      const first = words[0];
      const last = words[words.length - 1];
      return [{
        speaker: transcriptSpeaker(entry.role),
        text,
        ...(numberValue(first?.start) === undefined
          ? {}
          : { startMs: Math.round(first.start * 1_000) }),
        ...(numberValue(last?.end) === undefined
          ? {}
          : { endMs: Math.round(last.end * 1_000) }),
      }];
    });
    if (transcript.length) return transcript;
  }
  const text = stringValue(fallback);
  return text ? [{ speaker: "Conversation", text }] : [];
}

function transcriptSpeaker(role) {
  if (role === "agent") return "Agent";
  if (role === "user") return "Caller";
  if (role === "transfer_target") return "Transfer target";
  return "Conversation";
}

function callerNumber(call) {
  return stringValue(
    call.direction === "outbound" ? call.to_number : call.from_number,
  );
}

function timestampValue(value) {
  const timestamp = numberValue(value);
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationMs(call) {
  const explicit = numberValue(call.duration_ms);
  if (explicit !== undefined && explicit >= 0) return explicit;
  const start = numberValue(call.start_timestamp);
  const end = numberValue(call.end_timestamp);
  return start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined;
}

function isSuccessfulTestOutcome(outcome) {
  return outcome !== "failed" && outcome !== "abandoned";
}

function inferOutcome(call, toolLog) {
  const successfulTools = new Set(
    toolActions(toolLog)
      .filter(({ successful }) => successful)
      .map(({ name }) => name),
  );
  if (successfulTools.has("calendar_create_booking")) return "booked";
  if (
    successfulTools.has("call_transfer") ||
    [...successfulTools].some((name) => name.startsWith("transfer_call"))
  ) {
    return "escalated";
  }
  if (successfulTools.has("message_take")) return "message";
  if (successfulTools.has("lead_capture")) return "lead";
  const failure = [
    call?.call_status,
    call?.disconnection_reason,
  ].filter(Boolean).join(" ");
  if (/error|fail/i.test(failure)) return "failed";
  if (/no.?answer|dial.?busy|dial.?failed|machine/i.test(failure)) {
    return "abandoned";
  }
  return "answered";
}

function normalizeContact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    name: stringValue(value.name),
    phone: stringValue(value.phone),
    email: stringValue(value.email),
  };
}

function stableId(prefix, workspaceId, providerId) {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${providerId}`)
    .digest("hex");
  return `${prefix}-${digest.slice(0, 24)}`;
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function noContent() {
  return {
    statusCode: 204,
    headers: { "cache-control": "no-store" },
    body: "",
  };
}

async function getDefaultRetellApiKey() {
  if (!process.env.RETELL_SECRET_ARN) {
    throw new Error("RETELL_SECRET_ARN is required");
  }
  retellApiKeyPromise ??= import("@aws-sdk/client-secrets-manager")
    .then(async (commands) => {
      const client = new commands.SecretsManagerClient({});
      const result = await client.send(new commands.GetSecretValueCommand({
        SecretId: process.env.RETELL_SECRET_ARN,
      }));
      if (!result.SecretString) throw new Error("Retell secret string is empty");
      const secret = JSON.parse(result.SecretString);
      const apiKey = secret.apiKey ?? secret.api_key ?? secret.retellApiKey;
      if (typeof apiKey !== "string" || !apiKey) {
        throw new Error("Retell secret must contain apiKey");
      }
      return apiKey;
    });
  return retellApiKeyPromise;
}

export function createDynamoPostcallStore(client, commands, tableNames) {
  return {
    async findAgentByRetellAgentId(retellAgentId) {
      const result = await client.send(new commands.QueryCommand({
        TableName: requiredTable(tableNames.agents),
        IndexName: "retellAgentId-index",
        KeyConditionExpression: "retellAgentId = :retellAgentId",
        ExpressionAttributeValues: marshall({
          ":retellAgentId": retellAgentId,
        }),
        Limit: 1,
      }));
      return result.Items?.[0] ? unmarshall(result.Items[0]) : null;
    },

    async putCall(record) {
      await put(client, commands, tableNames.calls, record);
      return record;
    },

    async upsertAppointment(record) {
      await putIfMissing(
        client,
        commands,
        tableNames.appointments,
        record,
        "appointmentId",
      );
      return record;
    },

    async upsertLead(record) {
      await putIfMissing(
        client,
        commands,
        tableNames.leads,
        record,
        "leadId",
      );
      return record;
    },

    async upsertMessage(record) {
      await putIfMissing(
        client,
        commands,
        tableNames.messages,
        record,
        "messageId",
      );
      return record;
    },

    async markAgentTested(workspaceId, agentId, testedAt) {
      await client.send(new commands.UpdateItemCommand({
        TableName: requiredTable(tableNames.agents),
        Key: marshall({ workspaceId, agentId }),
        UpdateExpression:
          "SET tested = :tested, testedAt = :testedAt, updatedAt = :updatedAt",
        ConditionExpression: "attribute_exists(agentId)",
        ExpressionAttributeValues: marshall({
          ":tested": true,
          ":testedAt": testedAt,
          ":updatedAt": testedAt,
        }),
      }));
    },
  };
}

async function put(client, commands, tableName, record) {
  await client.send(new commands.PutItemCommand({
    TableName: requiredTable(tableName),
    Item: marshall(record),
  }));
}

async function putIfMissing(
  client,
  commands,
  tableName,
  record,
  idField,
) {
  try {
    await client.send(new commands.PutItemCommand({
      TableName: requiredTable(tableName),
      Item: marshall(record),
      ConditionExpression: "attribute_not_exists(#id)",
      ExpressionAttributeNames: { "#id": idField },
    }));
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
  }
}

function requiredTable(value) {
  if (!value) {
    throw new Error("Post-call DynamoDB table environment variable is required");
  }
  return value;
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
      Object.entries(value.M)
        .map(([key, item]) => [key, fromAttributeValue(item)]),
    );
  }
  return undefined;
}

function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item)
      .map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}

let retellApiKeyPromise;
let storePromise;
async function getDefaultStore() {
  storePromise ??= import("@aws-sdk/client-dynamodb").then((commands) =>
    createDynamoPostcallStore(
      new commands.DynamoDBClient({}),
      commands,
      {
        calls: process.env.CALLS_TABLE,
        appointments: process.env.APPOINTMENTS_TABLE,
        leads: process.env.LEADS_TABLE,
        messages: process.env.MESSAGES_TABLE,
        agents: process.env.AGENTS_TABLE,
      },
    )
  );
  return storePromise;
}

export const handler = createHandler();
