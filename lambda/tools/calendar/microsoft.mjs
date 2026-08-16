const API_BASE = "https://graph.microsoft.com/v1.0";

export function createMicrosoftCalendarClient({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async getAvailability({
      accessToken,
      calendarId,
      startTimeUtc,
      endTimeUtc,
    }) {
      const url = new URL(
        `${API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`,
      );
      url.searchParams.set("startDateTime", startTimeUtc);
      url.searchParams.set("endDateTime", endTimeUtc);
      url.searchParams.set("$select", "id,start,end,showAs,isCancelled");
      const body = await requestJson(fetchImpl, url.toString(), {
        accessToken,
        headers: { Prefer: 'outlook.timezone="UTC"' },
      });
      const busy = (body?.value ?? [])
        .filter((event) => event?.isCancelled !== true && event?.showAs !== "free")
        .map((event) => ({
          start: toUtc(event?.start),
          end: toUtc(event?.end),
          providerEventId: event?.id,
        }))
        .filter(({ start, end }) => start && end);
      return { available: busy.length === 0, busy };
    },

    async createBooking({
      accessToken,
      calendarId,
      providerId,
      startTimeUtc,
      endTimeUtc,
      timezone,
      service,
      description,
      location,
      customer,
    }) {
      const result = await requestJson(
        fetchImpl,
        `${API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          accessToken,
          body: {
            subject: service || "Appointment",
            body: description
              ? { contentType: "text", content: description }
              : undefined,
            location: location ? { displayName: location } : undefined,
            start: graphDateTime(startTimeUtc),
            end: graphDateTime(endTimeUtc),
            attendees: customer?.email ? [{
              emailAddress: {
                address: customer.email,
                name: customer.name || customer.email,
              },
              type: "required",
            }] : undefined,
            transactionId: providerId,
          },
        },
      );
      return normalizeEvent(result);
    },

    async rescheduleBooking({
      accessToken,
      providerEventId,
      startTimeUtc,
      endTimeUtc,
      timezone,
    }) {
      const result = await requestJson(
        fetchImpl,
        `${API_BASE}/me/events/${encodeURIComponent(providerEventId)}`,
        {
          method: "PATCH",
          accessToken,
          body: {
            start: graphDateTime(startTimeUtc),
            end: graphDateTime(endTimeUtc),
          },
        },
      );
      return normalizeEvent(result, providerEventId);
    },

    async cancelBooking({
      accessToken,
      providerEventId,
    }) {
      await requestJson(
        fetchImpl,
        `${API_BASE}/me/events/${encodeURIComponent(providerEventId)}`,
        { method: "DELETE", accessToken, allowEmpty: true },
      );
      return {
        provider: "microsoft-365-calendar",
        providerEventId,
      };
    },
  };
}

function graphDateTime(utcValue) {
  return {
    dateTime: new Date(utcValue).toISOString().replace(/Z$/, ""),
    timeZone: "UTC",
  };
}

function toUtc(value) {
  if (!value?.dateTime) return null;
  const suffix = /(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime) ? "" : "Z";
  const parsed = new Date(value.dateTime + suffix);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeEvent(event, fallbackId) {
  return {
    provider: "microsoft-365-calendar",
    providerEventId: event?.id ?? fallbackId,
    htmlLink: event?.webLink,
  };
}

async function requestJson(fetchImpl, url, {
  method = "GET",
  accessToken,
  body,
  headers = {},
  allowEmpty = false,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let value;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw providerError(
        "Microsoft Graph returned invalid JSON",
        502,
        "provider_api_error",
      );
    }
  }
  if (!response.ok) {
    const code = response.status === 401
      ? "provider_unauthorized"
      : "provider_api_error";
    throw providerError(
      value?.error?.message || "Microsoft Graph request failed",
      response.status,
      code,
    );
  }
  if (!text && !allowEmpty) {
    throw providerError(
      "Microsoft Graph returned an empty response",
      502,
      "provider_api_error",
    );
  }
  return value;
}

function providerError(message, statusCode, code) {
  const error = new Error(message);
  error.name = "CalendarProviderError";
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
