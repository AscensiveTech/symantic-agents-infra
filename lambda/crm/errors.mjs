// Provider-neutral CRM failure categories. Every adapter translates its own
// provider errors into one of these, so the sync worker and the call-time
// lookup decide retry/skip behavior without knowing which CRM is behind them.
export const CRM_ERROR = Object.freeze({
  TIMEOUT: "timeout",
  TRANSIENT: "transient",
  RATE_LIMITED: "rate_limited",
  DAILY_LIMIT: "daily_limit",
  CONFLICT: "conflict",
  LEASE_BUSY: "lease_busy",
  UNAUTHORIZED: "unauthorized",
  REAUTH_REQUIRED: "reauth_required",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  MAPPING_INVALID: "mapping_invalid",
  INVALID_VALUE: "invalid_value",
  NOT_CONNECTED: "not_connected",
  PROVIDER_ERROR: "provider_error",
});

const RETRYABLE = new Set([
  CRM_ERROR.TIMEOUT,
  CRM_ERROR.TRANSIENT,
  CRM_ERROR.RATE_LIMITED,
  CRM_ERROR.DAILY_LIMIT,
  CRM_ERROR.CONFLICT,
  CRM_ERROR.LEASE_BUSY,
  // Unrecognized provider errors are retried a bounded number of times and
  // then dead-lettered, where a person can look at them.
  CRM_ERROR.PROVIDER_ERROR,
]);

export class CrmError extends Error {
  constructor(code, message, {
    retryAfterSeconds,
    providerCode,
    statusCode,
    resource,
    problems,
  } = {}) {
    super(message);
    this.name = "CrmError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = Math.ceil(retryAfterSeconds);
    }
    if (providerCode) this.providerCode = providerCode;
    if (statusCode) this.statusCode = statusCode;
    if (resource) this.resource = resource;
    if (problems) this.problems = problems;
  }
}

// A safe, bounded summary for logs: never the message body of a provider
// response (it can echo customer data), only codes.
export function describeError(error) {
  if (error instanceof CrmError) {
    return {
      code: error.code,
      providerCode: error.providerCode,
      statusCode: error.statusCode,
      resource: error.resource,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  // Not a provider error: most likely our bug or an AWS SDK failure, so the
  // message matters for debugging. Bounded, with digit runs (phone numbers
  // inside a key, say) masked.
  const message = typeof error?.message === "string"
    ? error.message.replace(/\d{7,}/g, "***").slice(0, 200)
    : undefined;
  return { code: "unexpected", name: error?.name, message };
}
