const API_BASE = "https://www.googleapis.com/calendar/v3";

export function createGoogleCalendarClient({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async getAvailability({
      accessToken,
      calendarId,
      startTimeUtc,
      endTimeUtc,
      timezone,
    }) {
      const body = await requestJson(fetchImpl, `${API_BASE}/freeBusy`, {
        method: "POST",
        accessToken,
        body: {
          timeMin: startTimeUtc,
          timeMax: endTimeUtc,
          timeZone: timezone,
          items: [{ id: calendarId }],
        },
      });
      const calendar = body?.calendars?.[calendarId];
      if (calendar?.errors?.length) {
        throw providerError(
          "Google Calendar could not read free/busy data",
          502,
          "provider_api_error",
        );
      }
      const busy = Array.isArray(calendar?.busy) ? calendar.busy : [];
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
      callId,
      idempotencyKey,
    }) {
      const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}` +
        "/events?sendUpdates=all";
      const event = {
        id: providerId,
        summary: service || "Appointment",
        description: description || undefined,
        location: location || undefined,
        start: { dateTime: startTimeUtc, timeZone: timezone },
        end: { dateTime: endTimeUtc, timeZone: timezone },
        attendees: customer?.email ? [{
          email: customer.email,
          displayName: customer.name || undefined,
        }] : undefined,
        extendedProperties: {
          private: {
            symanticCallId: callId,
            symanticIdempotencyKey: idempotencyKey,
          },
        },
      };
      try {
        const result = await requestJson(fetchImpl, url, {
          method: "POST",
          accessToken,
          body: event,
        });
        return normalizeEvent(result, providerId);
      } catch (error) {
        if (error?.statusCode !== 409) throw error;
        const existing = await requestJson(
          fetchImpl,
          `${API_BASE}/calendars/${encodeURIComponent(calendarId)}` +
            `/events/${encodeURIComponent(providerId)}`,
          { accessToken },
        );
        return normalizeEvent(existing, providerId);
      }
    },

    async rescheduleBooking({
      accessToken,
      calendarId,
      providerEventId,
      startTimeUtc,
      endTimeUtc,
      timezone,
    }) {
      const result = await requestJson(
        fetchImpl,
        `${API_BASE}/calendars/${encodeURIComponent(calendarId)}` +
          `/events/${encodeURIComponent(providerEventId)}?sendUpdates=all`,
        {
          method: "PATCH",
          accessToken,
          body: {
            start: { dateTime: startTimeUtc, timeZone: timezone },
            end: { dateTime: endTimeUtc, timeZone: timezone },
          },
        },
      );
      return normalizeEvent(result, providerEventId);
    },

    async cancelBooking({
      accessToken,
      calendarId,
      providerEventId,
    }) {
      try {
        await requestJson(
          fetchImpl,
          `${API_BASE}/calendars/${encodeURIComponent(calendarId)}` +
            `/events/${encodeURIComponent(providerEventId)}?sendUpdates=all`,
          { method: "DELETE", accessToken, allowEmpty: true },
        );
      } catch (error) {
        if (error?.statusCode !== 410) throw error;
      }
      return {
        provider: "google-calendar",
        providerEventId,
      };
    },
  };
}

function normalizeEvent(event, fallbackId) {
  return {
    provider: "google-calendar",
    providerEventId: event?.id ?? fallbackId,
    htmlLink: event?.htmlLink,
  };
}

async function requestJson(fetchImpl, url, {
  method = "GET",
  accessToken,
  body,
  allowEmpty = false,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
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
        "Google Calendar returned invalid JSON",
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
      value?.error?.message || "Google Calendar request failed",
      response.status,
      code,
    );
  }
  if (!text && !allowEmpty) {
    throw providerError(
      "Google Calendar returned an empty response",
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
