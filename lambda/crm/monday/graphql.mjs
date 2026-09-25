import { createHash } from "node:crypto";

import { CRM_ERROR, CrmError } from "../errors.mjs";

const MONDAY_API_URL = "https://api.monday.com/v2";
// Pinned so a quarterly Monday release can't change behavior under us. Bump
// deliberately (and rerun the tests) when this version enters maintenance.
export const DEFAULT_MONDAY_API_VERSION = "2026-07";
const DEFAULT_TIMEOUT_MS = 8_000;

// Monday reports most failures as HTTP 200 with errors[].extensions.code, and
// some as real HTTP statuses. Both paths land here.
const CODE_MAP = new Map([
  ["ComplexityException", CRM_ERROR.RATE_LIMITED],
  ["COMPLEXITY_BUDGET_EXHAUSTED", CRM_ERROR.RATE_LIMITED],
  ["RATE_LIMIT_EXCEEDED", CRM_ERROR.RATE_LIMITED],
  ["Rate Limit Exceeded", CRM_ERROR.RATE_LIMITED],
  ["maxConcurrencyExceeded", CRM_ERROR.RATE_LIMITED],
  ["IP_RATE_LIMIT_EXCEEDED", CRM_ERROR.RATE_LIMITED],
  ["DAILY_LIMIT_EXCEEDED", CRM_ERROR.DAILY_LIMIT],
  ["API_TEMPORARILY_BLOCKED", CRM_ERROR.TRANSIENT],
  ["IDEMPOTENCY_CONFLICT", CRM_ERROR.CONFLICT],
  ["Resource is currently locked", CRM_ERROR.CONFLICT],
  ["InvalidBoardIdException", CRM_ERROR.MAPPING_INVALID],
  ["InvalidColumnIdException", CRM_ERROR.MAPPING_INVALID],
  ["InvalidUserIdException", CRM_ERROR.MAPPING_INVALID],
  ["ColumnValueException", CRM_ERROR.INVALID_VALUE],
  ["CorrectedValueException", CRM_ERROR.INVALID_VALUE],
  ["ItemNameTooLongException", CRM_ERROR.INVALID_VALUE],
  ["ItemsLimitationException", CRM_ERROR.INVALID_VALUE],
  ["RecordInvalidException", CRM_ERROR.INVALID_VALUE],
  ["InvalidArgumentException", CRM_ERROR.INVALID_VALUE],
  ["InvalidItemIdException", CRM_ERROR.NOT_FOUND],
  ["ItemNotFoundInBoard", CRM_ERROR.NOT_FOUND],
  ["ResourceNotFoundException", CRM_ERROR.NOT_FOUND],
  ["missingRequiredPermissions", CRM_ERROR.FORBIDDEN],
  ["UserUnauthorizedException", CRM_ERROR.FORBIDDEN],
  ["USER_ACCESS_DENIED", CRM_ERROR.FORBIDDEN],
  ["Unauthorized", CRM_ERROR.UNAUTHORIZED],
]);

export function createMondayGraphqlClient({
  fetchImpl = globalThis.fetch,
  apiVersion = DEFAULT_MONDAY_API_VERSION,
  endpoint = MONDAY_API_URL,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  metrics,
  now = Date.now,
} = {}) {
  /**
   * Run one GraphQL document. `operation` names the call for metrics.
   * With `allowPartial`, field-level errors come back alongside the data that
   * did succeed (used for multi-mutation documents) instead of throwing.
   */
  async function request({
    accessToken,
    query,
    variables,
    operation = "query",
    idempotencyKey,
    timeoutMs = defaultTimeoutMs,
    allowPartial = false,
  }) {
    if (typeof accessToken !== "string" || !accessToken) {
      throw new CrmError(CRM_ERROR.UNAUTHORIZED, "Monday access token is missing");
    }
    const requestBody = JSON.stringify({ query, variables: variables ?? {} });
    // The key names the intent (this call's create / note); the body hash
    // makes a changed request - e.g. after the admin fixes the mapping - a new
    // request rather than a replay of whatever Monday cached for the old one.
    const effectiveKey = idempotencyKey
      ? `${idempotencyKey}-${createHash("sha256").update(requestBody).digest("hex").slice(0, 16)}`
      : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Number(now());
    let outcome = "ok";
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
            "api-version": apiVersion,
            ...(effectiveKey ? { "idempotency-key": effectiveKey } : {}),
          },
          body: requestBody,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") {
          throw new CrmError(CRM_ERROR.TIMEOUT, `Monday ${operation} timed out`);
        }
        throw new CrmError(CRM_ERROR.TRANSIENT, `Monday ${operation} network failure`);
      }

      const body = await readJson(response);
      const retryAfter = retryAfterSeconds(response, body);
      if (!response.ok) {
        throw classifyHttp(response.status, body, retryAfter, operation);
      }
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      // Legacy shape: { error_code, error_message } with HTTP 200.
      if (!errors.length && typeof body?.error_code === "string") {
        errors.push({ message: body.error_message, extensions: { code: body.error_code } });
      }
      if (errors.length) {
        const classified = errors.map((error) => classifyGraphqlError(error, retryAfter, operation));
        const hasData = body?.data && Object.values(body.data).some((value) => value !== null);
        if (allowPartial && hasData) return { data: body.data, errors: classified };
        throw mostSevere(classified);
      }
      if (!body || typeof body !== "object" || !("data" in body)) {
        throw new CrmError(CRM_ERROR.TRANSIENT, `Monday ${operation} returned no data`);
      }
      return allowPartial ? { data: body.data, errors: [] } : body.data;
    } catch (error) {
      outcome = error instanceof CrmError ? error.code : "unexpected";
      throw error;
    } finally {
      clearTimeout(timer);
      metrics?.emit("ApiLatency", Number(now()) - started, {
        Provider: "monday",
        Operation: operation,
      });
      metrics?.count("ApiCall", { Provider: "monday", Operation: operation, Outcome: outcome });
    }
  }

  return { request, apiVersion };
}

function classifyHttp(status, body, retryAfter, operation) {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  const providerCode = first?.extensions?.code ?? body?.error_code;
  if (providerCode && CODE_MAP.has(providerCode)) {
    return classifyGraphqlError(first ?? { extensions: { code: providerCode } }, retryAfter, operation, status);
  }
  if (status === 401) {
    return new CrmError(CRM_ERROR.UNAUTHORIZED, `Monday ${operation} unauthorized`, { statusCode: status });
  }
  if (status === 403) {
    return new CrmError(CRM_ERROR.FORBIDDEN, `Monday ${operation} forbidden`, { statusCode: status, providerCode });
  }
  if (status === 404) {
    return new CrmError(CRM_ERROR.NOT_FOUND, `Monday ${operation} not found`, { statusCode: status, providerCode });
  }
  if (status === 409 || status === 423) {
    return new CrmError(CRM_ERROR.CONFLICT, `Monday ${operation} conflict`, {
      statusCode: status,
      providerCode,
      retryAfterSeconds: retryAfter ?? 5,
    });
  }
  if (status === 429) {
    return new CrmError(CRM_ERROR.RATE_LIMITED, `Monday ${operation} rate limited`, {
      statusCode: status,
      providerCode,
      retryAfterSeconds: retryAfter ?? 60,
    });
  }
  if (status >= 500) {
    return new CrmError(CRM_ERROR.TRANSIENT, `Monday ${operation} server error`, { statusCode: status });
  }
  return new CrmError(CRM_ERROR.INVALID_VALUE, `Monday ${operation} rejected the request`, {
    statusCode: status,
    providerCode,
  });
}

function classifyGraphqlError(error, retryAfter, operation, statusCode) {
  const providerCode = error?.extensions?.code ?? error?.extensions?.error_code ?? null;
  const code = CODE_MAP.get(providerCode) ?? CRM_ERROR.PROVIDER_ERROR;
  const perError = Number(
    error?.extensions?.retry_in_seconds ?? error?.extensions?.error_data?.retry_in_seconds,
  );
  let retryAfterSeconds = Number.isFinite(perError) && perError > 0 ? perError : retryAfter;
  if (code === CRM_ERROR.RATE_LIMITED) retryAfterSeconds ??= 60;
  if (code === CRM_ERROR.CONFLICT) retryAfterSeconds ??= 5;
  const errorData = error?.extensions?.error_data ?? {};
  const resource = code === CRM_ERROR.MAPPING_INVALID
    ? providerCode === "InvalidBoardIdException"
      ? "board"
      : providerCode === "InvalidUserIdException" ? "owner" : "column"
    : code === CRM_ERROR.NOT_FOUND
      ? (errorData.item_id || /item/i.test(String(error?.message)) ? "item" : "resource")
      : undefined;
  return new CrmError(code, `Monday ${operation} failed (${providerCode ?? "unknown"})`, {
    providerCode: providerCode ?? undefined,
    statusCode: Number(error?.extensions?.status_code) || statusCode,
    retryAfterSeconds,
    resource,
  });
}

// When a document fails for several reasons, act on the one that matters
// most: an auth or quota problem outranks a bad column value.
const SEVERITY = [
  CRM_ERROR.UNAUTHORIZED,
  CRM_ERROR.DAILY_LIMIT,
  CRM_ERROR.RATE_LIMITED,
  CRM_ERROR.FORBIDDEN,
  CRM_ERROR.MAPPING_INVALID,
  CRM_ERROR.CONFLICT,
  CRM_ERROR.TRANSIENT,
  CRM_ERROR.NOT_FOUND,
  CRM_ERROR.INVALID_VALUE,
  CRM_ERROR.PROVIDER_ERROR,
];

function mostSevere(errors) {
  return [...errors].sort(
    (a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code),
  )[0];
}

function retryAfterSeconds(response, body) {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const field = Number(body?.retry_in_seconds ?? body?.error_data?.retry_in_seconds);
  return Number.isFinite(field) && field > 0 ? field : undefined;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
