import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ROUTE = "/retell/webhooks/call-ended";
export const MAX_MARSHALLED_CALL_ITEM_BYTES = 380 * 1024;

// Whole-minute billing: any call with talk time bills at least one minute.
export function billedMinutes(durationMs) {
  return typeof durationMs === "number" && durationMs > 0
    ? Math.ceil(durationMs / 60_000)
    : 0;
}

// tz-local YYYY-MM for a call's start timestamp — the billing cycle it belongs to.
export function periodKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    return year && month ? `${year}-${month}` : null;
  } catch {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

const CALLER_NAME_PATTERN =
  /\b(?:my name is|this is|i['’]?m|i am|it['’]?s|speaking[,]? this is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i;
const CALLER_NAME_STOPWORDS = new Set([
  "calling", "here", "sorry", "just", "not", "trying", "looking", "wondering",
  "hoping", "with", "from", "the", "a", "an", "good", "so", "actually",
]);

// Best-effort caller name when the agent didn't capture one: scan the caller's
// own turns for a self-introduction. Returns a title-cased name or undefined.
export function extractCallerNameFromTranscript(transcript) {
  if (!Array.isArray(transcript)) return undefined;
  for (const entry of transcript) {
    if (!entry || entry.speaker !== "Caller" || typeof entry.text !== "string") continue;
    const match = entry.text.match(CALLER_NAME_PATTERN);
    if (!match) continue;
    const name = match[1].trim().replace(/\s+/g, " ");
    if (name.length > 40) continue;
    const [first] = name.toLowerCase().split(" ");
    if (CALLER_NAME_STOPWORDS.has(first)) continue;
    return name
      .split(" ")
      .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }
  return undefined;
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

export function createHandler({
  verifySignature = verifyRetellSignature,
  getRetellApiKey = getDefaultRetellApiKey,
  getStore = getDefaultStore,
  getRecordingStore = getDefaultRecordingStore,
  getUsageStore = getDefaultUsageStore,
  fetchImpl = globalThis.fetch,
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
    const eventType = payload?.event;
    if (eventType !== "call_ended" && eventType !== "call_analyzed") {
      return json(400, { message: "A call_ended or call_analyzed payload is required" });
    }
    const call = payload.call;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      return json(400, { message: "A call payload is required" });
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
    const analysis = call.call_analysis && typeof call.call_analysis === "object"
      ? call.call_analysis
      : {};
    // The recording URL from Retell is short-lived; on `call_analyzed` (where it is
    // final) we copy the audio into our own S3 so it stays available and access-controlled.
    let recordingKey;
    if (eventType === "call_analyzed") {
      recordingKey = await captureRecording({
        recordingUrl: stringValue(call.recording_url),
        workspaceId,
        callId,
        getRecordingStore,
        fetchImpl,
      });
    }
    const buildCallRecord = (transcript, storedToolLog, truncated) => {
      const transcriptName = summary.callerName
        ? undefined
        : extractCallerNameFromTranscript(transcript);
      return {
      workspaceId,
      callId,
      retellCallId,
      agentId,
      direction: stringValue(call.direction),
      callerNumber: callerNumber(call),
      callerName: summary.callerName ?? transcriptName,
      callerNameSource: summary.callerName
        ? "agent"
        : (transcriptName ? "transcript" : undefined),
      intent: summary.intent,
      startedAt: timestampValue(call.start_timestamp),
      endedAt: timestampValue(call.end_timestamp),
      durationMs: durationMs(call),
      recordingKey,
      disconnectionReason: stringValue(call.disconnection_reason),
      transcript,
      toolLog: storedToolLog,
      actions: describeActions(toolLog),
      callSummary: stringValue(analysis.call_summary),
      userSentiment: stringValue(analysis.user_sentiment),
      callSuccessful: typeof analysis.call_successful === "boolean" ? analysis.call_successful : undefined,
      inVoicemail: typeof analysis.in_voicemail === "boolean" ? analysis.in_voicemail : undefined,
      ...(truncated
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
    };
    const content = truncateCallContent(
      normalizeTranscript(call.transcript_object, call.transcript),
      toolLog,
      buildCallRecord,
    );
    const record = buildCallRecord(
      content.transcript,
      content.toolLog,
      content.truncated,
    );
    try {
      store ??= await getStore();
      // Merge rather than overwrite: `call_ended` and `call_analyzed` can arrive in
      // either order, and each carries fields the other may not.
      const upsert = (await store.upsertCall(record)) ?? {};
      await backfillToolRecords(store, { ...record, toolLog });
      // Maintain the per-cycle usage counter that gates the inbound hard stop.
      // Only the first (item-creating) write of a call increments it, so the
      // call_ended + call_analyzed webhooks stay idempotent.
      if (upsert.created) {
        await incrementUsageCounter({
          getUsageStore,
          store,
          workspaceId,
          startedAt: record.startedAt ?? timestamp,
          durationMs: record.durationMs,
        });
      }
      if (
        eventType === "call_ended" &&
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

function truncateCallContent(transcript, toolLog, buildCallRecord) {
  if (
    marshalledCallItemBytes(buildCallRecord(transcript, toolLog, false)) <=
    MAX_MARSHALLED_CALL_ITEM_BYTES
  ) {
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
    marshalledCallItemBytes(
      buildCallRecord(limitedTranscript, limitedToolLog, true),
    ) > MAX_MARSHALLED_CALL_ITEM_BYTES
  ) {
    limitedTranscript.pop();
  }
  while (
    limitedToolLog.length &&
    marshalledCallItemBytes(
      buildCallRecord(limitedTranscript, limitedToolLog, true),
    ) > MAX_MARSHALLED_CALL_ITEM_BYTES
  ) {
    limitedToolLog.pop();
  }
  return {
    transcript: limitedTranscript,
    toolLog: limitedToolLog,
    truncated: true,
  };
}

export function marshalledCallItemBytes(record) {
  return Buffer.byteLength(JSON.stringify(marshall(record)), "utf8");
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

function describeActions(toolLog) {
  const out = toolActions(toolLog)
    .filter(({ successful }) => successful)
    .flatMap(({ name, arguments: args }) => {
      if (name === "calendar_create_booking") {
        const service = stringValue(args?.service);
        return [service ? `Booked appointment · ${service}` : "Booked an appointment"];
      }
      if (name === "calendar_reschedule_booking") return ["Rescheduled an appointment"];
      if (name === "calendar_cancel_booking") return ["Cancelled an appointment"];
      if (name === "message_take") return ["Took a message for the office"];
      if (name === "lead_capture") return ["Captured a new lead"];
      if (name === "call_transfer" || (typeof name === "string" && name.startsWith("transfer_call"))) {
        return ["Transferred the call"];
      }
      return [];
    });
  return out.length ? out : undefined;
}

// Copy the Retell recording into our own S3 bucket. Returns the object key on success,
// undefined on any failure (a missing recording must never fail the webhook).
async function captureRecording({ recordingUrl, workspaceId, callId, getRecordingStore, fetchImpl }) {
  if (!recordingUrl || typeof fetchImpl !== "function") return undefined;
  let store;
  try {
    store = await getRecordingStore();
  } catch (error) {
    console.error("Recording store unavailable", { name: error?.name, message: error?.message });
    return undefined;
  }
  if (!store || typeof store.putRecording !== "function") return undefined;
  try {
    const response = await fetchImpl(recordingUrl);
    if (!response || !response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) return undefined;
    const key = `calls/${callId}.wav`;
    const contentType = stringValue(response.headers?.get?.("content-type")) || "audio/wav";
    await store.putRecording(`workspaces/${workspaceId}/${key}`, bytes, contentType);
    return key;
  } catch (error) {
    console.error("Recording capture failed", { name: error?.name, message: error?.message, callId });
    return undefined;
  }
}

// Add this call's billed minutes to the workspace's current-cycle counter.
// Never throws — a failed counter update must not fail the webhook (the Billing
// page's authoritative total is recomputed from the calls table anyway).
async function incrementUsageCounter({ getUsageStore, workspaceId, startedAt, durationMs }) {
  const minutes = billedMinutes(durationMs);
  if (minutes <= 0) return;
  try {
    const usage = await getUsageStore();
    if (!usage || typeof usage.increment !== "function") return;
    const timezone = typeof usage.getTimezone === "function"
      ? await usage.getTimezone(workspaceId)
      : "UTC";
    const period = periodKey(startedAt, timezone || "UTC");
    if (!period) return;
    await usage.increment(workspaceId, period, minutes);
  } catch (error) {
    console.error("Usage counter update failed", {
      name: error?.name,
      message: error?.message,
      workspaceId,
    });
  }
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
  return outcome !== "failed" && outcome !== "abandoned" && outcome !== "spam";
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
  // Retell's post-call analysis flags spam via a custom is_spam field. A call
  // that completed a real action above is never spam.
  const analysis = call?.call_analysis && typeof call.call_analysis === "object"
    ? call.call_analysis
    : {};
  const custom = analysis.custom_analysis_data
      && typeof analysis.custom_analysis_data === "object"
    ? analysis.custom_analysis_data
    : {};
  if (custom.is_spam === true) return "spam";
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

    async upsertCall(record) {
      const reserved = new Set(["workspaceId", "callId", "createdAt"]);
      const entries = Object.entries(record)
        .filter(([key, value]) => value !== undefined && !reserved.has(key));
      const names = { "#createdAt": "createdAt" };
      const values = { ":createdAt": record.createdAt ?? new Date().toISOString() };
      const sets = ["#createdAt = if_not_exists(#createdAt, :createdAt)"];
      entries.forEach(([key, value], index) => {
        names[`#k${index}`] = key;
        values[`:v${index}`] = value;
        sets.push(`#k${index} = :v${index}`);
      });
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: requiredTable(tableNames.calls),
        Key: marshall({ workspaceId: record.workspaceId, callId: record.callId }),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
        ReturnValues: "ALL_OLD",
      }));
      return { record, created: !result.Attributes };
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

export function createS3RecordingStore(client, commands, bucket) {
  return {
    async putRecording(key, body, contentType) {
      await client.send(new commands.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
    },
  };
}

export function createDynamoUsageStore(client, commands, { usageTable, profilesTable }) {
  return {
    async getTimezone(workspaceId) {
      if (!profilesTable) return "UTC";
      const result = await client.send(new commands.GetItemCommand({
        TableName: profilesTable,
        Key: marshall({ workspaceId }),
        ProjectionExpression: "#tz",
        ExpressionAttributeNames: { "#tz": "timezone" },
      }));
      return (result.Item && fromAttributeValue(result.Item.timezone)) || "UTC";
    },
    async increment(workspaceId, period, minutes) {
      await client.send(new commands.UpdateItemCommand({
        TableName: requiredTable(usageTable),
        Key: marshall({ workspaceId, period }),
        UpdateExpression:
          "ADD billedMinutes :m, callCount :one SET expiresAt = if_not_exists(expiresAt, :exp)",
        ExpressionAttributeValues: marshall({
          ":m": minutes,
          ":one": 1,
          ":exp": Math.floor(Date.now() / 1000) + 18 * 30 * 24 * 60 * 60,
        }),
      }));
    },
  };
}

let retellApiKeyPromise;
let storePromise;
let recordingStorePromise;
let usageStorePromise;
async function getDefaultUsageStore() {
  if (!process.env.WORKSPACE_USAGE_TABLE) return null;
  usageStorePromise ??= import("@aws-sdk/client-dynamodb").then((commands) =>
    createDynamoUsageStore(new commands.DynamoDBClient({}), commands, {
      usageTable: process.env.WORKSPACE_USAGE_TABLE,
      profilesTable: process.env.BUSINESS_PROFILES_TABLE,
    })
  );
  return usageStorePromise;
}
async function getDefaultRecordingStore() {
  if (!process.env.CALL_ARTIFACTS_BUCKET) return null;
  recordingStorePromise ??= import("@aws-sdk/client-s3").then((commands) =>
    createS3RecordingStore(
      new commands.S3Client({}),
      commands,
      process.env.CALL_ARTIFACTS_BUCKET,
    )
  );
  return recordingStorePromise;
}

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
