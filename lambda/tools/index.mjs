import { createHmac, timingSafeEqual } from "node:crypto";

import { getDefaultCalendarAdapter } from "./calendar/index.mjs";
import { handleAvailability } from "./handlers/availability.mjs";
import {
  handleCancelBooking,
  handleCreateBooking,
  handleFindAppointment,
  handleRescheduleBooking,
} from "./handlers/booking.mjs";
import { ToolRequestError } from "./handlers/errors.mjs";
import { handleLeadCapture } from "./handlers/lead.mjs";
import { handleMessageTake } from "./handlers/message.mjs";
import { handleTransfer } from "./handlers/transfer.mjs";
import { createDynamoToolsStore } from "./store.mjs";

const ROUTES = new Set([
  "/retell/tools/calendar.findAppointment",
  "/retell/tools/calendar.getAvailability",
  "/retell/tools/calendar.createBooking",
  "/retell/tools/calendar.rescheduleBooking",
  "/retell/tools/calendar.cancelBooking",
  "/retell/tools/lead.capture",
  "/retell/tools/message.take",
  "/retell/tools/call.transfer",
]);

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
  getCalendar = getDefaultCalendarAdapter,
  notifyOffice = defaultNotifyOffice,
  now = () => new Date(),
} = {}) {
  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
    if (method !== "POST" || !ROUTES.has(path)) {
      return json(404, { message: "Not found" });
    }

    const rawBody = readRawBody(event);
    const signature = readHeader(event?.headers, "x-retell-signature");
    if (!signature || rawBody === null) {
      return json(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
    }
    try {
      const apiKey = await getRetellApiKey();
      const verified = await verifySignature(rawBody, apiKey, signature);
      if (!verified) {
        return json(401, {
          ok: false,
          code: "unauthorized",
          message: "Unauthorized",
        });
      }
    } catch (error) {
      console.error("Retell signature verification failed", {
        name: error?.name,
        message: error?.message,
      });
      return json(500, {
        ok: false,
        code: "signature_verification_unavailable",
        message: "Request verification is unavailable.",
      });
    }

    let input;
    try {
      input = normalizeToolInput(JSON.parse(rawBody));
    } catch {
      return json(400, {
        ok: false,
        code: "invalid_request",
        message: "Invalid JSON body",
      });
    }
    const missing = ["workspaceId", "callId", "idempotencyKey"].find(
      (field) =>
        typeof input?.[field] !== "string" ||
        input[field].trim().length === 0,
    );
    if (missing) {
      return json(400, {
        ok: false,
        code: "invalid_request",
        message: `${missing} is required`,
      });
    }

    try {
      const store = await getStore();
      const context = { store, notifyOffice, now };
      let result;
      if (path === "/retell/tools/lead.capture") {
        result = await handleLeadCapture(input, context);
      } else if (path === "/retell/tools/message.take") {
        result = await handleMessageTake(input, context);
      } else if (path === "/retell/tools/call.transfer") {
        result = await handleTransfer(input, context);
      } else {
        const calendar = await getCalendar();
        const calendarContext = { ...context, calendar };
        if (path === "/retell/tools/calendar.findAppointment") {
          result = await handleFindAppointment(input, calendarContext);
        } else if (path === "/retell/tools/calendar.getAvailability") {
          result = await handleAvailability(input, calendarContext);
        } else if (path === "/retell/tools/calendar.createBooking") {
          result = await handleCreateBooking(input, calendarContext);
        } else if (path === "/retell/tools/calendar.rescheduleBooking") {
          result = await handleRescheduleBooking(input, calendarContext);
        } else {
          result = await handleCancelBooking(input, calendarContext);
        }
      }
      return json(200, result);
    } catch (error) {
      if (
        error?.code === "calendar_reauth_required" ||
        error?.reauthRequired === true
      ) {
        return json(200, {
          ok: false,
          code: "calendar_reauth_required",
          disableBookingTools: true,
          action: "take_message",
          message:
            "The calendar needs to be reconnected. I can take a message and have the office follow up.",
        });
      }
      if (error instanceof ToolRequestError) {
        const statusCode = path.startsWith("/retell/tools/calendar.") &&
            error.transportError !== true
          ? 200
          : error.statusCode;
        return json(statusCode, {
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.action ? { action: error.action } : {}),
        });
      }
      console.error("Retell tool request failed", {
        path,
        name: error?.name,
        message: error?.message,
        code: error?.code,
      });
      if (path.startsWith("/retell/tools/calendar.")) {
        return json(200, {
          ok: false,
          code: "provider_error",
          message:
            "I couldn't complete that calendar booking. I can take a message for the office.",
          action: "take_message",
        });
      }
      return json(500, {
        ok: false,
        code: "internal_error",
        message: "The request could not be completed.",
      });
    }
  };
}

function normalizeToolInput(payload) {
  if (
    !payload?.args ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    return payload;
  }
  const metadata = payload?.call?.metadata ?? {};
  const dynamicVariables = payload?.call?.retell_llm_dynamic_variables ?? {};
  const callId = payload?.call?.call_id ?? payload.args.callId;
  const invocation = Array.isArray(payload?.call?.transcript_with_tool_calls)
    ? [...payload.call.transcript_with_tool_calls].reverse().find((entry) =>
      entry?.role === "tool_call_invocation" &&
      entry?.name === payload.name &&
      typeof entry?.tool_call_id === "string" &&
      entry.tool_call_id
    )
    : null;
  return {
    ...payload.args,
    workspaceId: payload.args.workspaceId ??
      metadata.workspaceId ??
      dynamicVariables.workspaceId,
    agentId: payload.args.agentId ??
      metadata.agentId ??
      dynamicVariables.agentId,
    callId,
    idempotencyKey: invocation
      ? `${callId}:${invocation.tool_call_id}`
      : payload.args.idempotencyKey,
  };
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

let storePromise;
async function getDefaultStore() {
  storePromise ??= import("@aws-sdk/client-dynamodb").then((commands) =>
    createDynamoToolsStore(
      new commands.DynamoDBClient({}),
      commands,
      {
        calendarConnections: process.env.CALENDAR_CONNECTIONS_TABLE,
        appointments: process.env.APPOINTMENTS_TABLE,
        leads: process.env.LEADS_TABLE,
        messages: process.env.MESSAGES_TABLE,
        calls: process.env.CALLS_TABLE,
        agents: process.env.AGENTS_TABLE,
        businessProfiles: process.env.BUSINESS_PROFILES_TABLE,
      },
    )
  );
  return storePromise;
}

let retellApiKeyPromise;
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

async function defaultNotifyOffice(kind, record) {
  console.info("notify_pending", {
    kind,
    workspaceId: record.workspaceId,
    callId: record.callId,
    recordId: record.leadId ?? record.messageId,
  });
  return { status: "pending" };
}

export const handler = createHandler();
