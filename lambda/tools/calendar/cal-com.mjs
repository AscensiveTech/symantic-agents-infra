// Cal.com API v2 client. Authenticates with the customer's own Cal.com API
// key, passed in as `accessToken` so it fits the same adapter call shape as
// the Google/Microsoft clients. Cal.com owns the scheduling rules itself
// (event type length, buffers, minimum notice, which team member hosts,
// round-robin), so this client only asks it for open slots and books into
// one of the event types the business picked.
const API_BASE = "https://api.cal.com/v2";
const SLOTS_API_VERSION = "2024-09-04";
const BOOKINGS_API_VERSION = "2026-02-25";

export function createCalComClient({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async getAvailability({
      accessToken,
      eventTypeId,
      startTimeUtc,
      endTimeUtc,
      providerEventId,
    }) {
      requireEventTypeId(eventTypeId);
      const query = new URLSearchParams({
        eventTypeId: String(eventTypeId),
        start: startTimeUtc,
        end: endTimeUtc,
        timeZone: "UTC",
        format: "range",
        // While rescheduling, the booking being moved must not count as
        // busy against its own new time.
        ...(providerEventId ? { bookingUidToReschedule: providerEventId } : {}),
      });
      const body = await requestJson(fetchImpl, `${API_BASE}/slots?${query}`, {
        accessToken,
        version: SLOTS_API_VERSION,
      });
      const wanted = Date.parse(startTimeUtc);
      const slots = Object.values(body?.data ?? {}).flat();
      const available = slots.some((slot) =>
        Date.parse(typeof slot === "string" ? slot : slot?.start) === wanted
      );
      return { available, busy: [] };
    },

    async createBooking({
      accessToken,
      eventTypeId,
      startTimeUtc,
      timezone,
      customer,
      attendeeEmail,
      callId,
      idempotencyKey,
    }) {
      requireEventTypeId(eventTypeId);
      // Cal.com requires an attendee email on every booking. Callers are
      // never asked for theirs, so this is the business's own Booking Invite
      // Email - Cal.com's confirmation emails go to the business, not the
      // caller.
      if (!attendeeEmail) {
        throw providerError(
          "A Booking Invite Email is required to book through Cal.com",
          400,
          "provider_api_error",
        );
      }
      const body = await requestJson(fetchImpl, `${API_BASE}/bookings`, {
        method: "POST",
        accessToken,
        version: BOOKINGS_API_VERSION,
        body: {
          start: startTimeUtc,
          eventTypeId: Number(eventTypeId),
          attendee: {
            name: customer?.name || "Caller",
            email: attendeeEmail,
            timeZone: timezone || "UTC",
            ...(customer?.phone ? { phoneNumber: customer.phone } : {}),
          },
          metadata: {
            ...(callId ? { symanticCallId: String(callId).slice(0, 500) } : {}),
            ...(idempotencyKey ? { symanticIdempotencyKey: String(idempotencyKey).slice(0, 500) } : {}),
          },
        },
      });
      return normalizeBooking(body?.data);
    },

    async rescheduleBooking({
      accessToken,
      providerEventId,
      startTimeUtc,
    }) {
      const body = await requestJson(
        fetchImpl,
        `${API_BASE}/bookings/${encodeURIComponent(providerEventId)}/reschedule`,
        {
          method: "POST",
          accessToken,
          version: BOOKINGS_API_VERSION,
          body: { start: startTimeUtc },
        },
      );
      // Cal.com creates a new booking with its own uid when rescheduling -
      // the caller must store it, or a later cancel would target the old one.
      return normalizeBooking(body?.data, providerEventId);
    },

    async cancelBooking({
      accessToken,
      providerEventId,
    }) {
      try {
        await requestJson(
          fetchImpl,
          `${API_BASE}/bookings/${encodeURIComponent(providerEventId)}/cancel`,
          {
            method: "POST",
            accessToken,
            version: BOOKINGS_API_VERSION,
            body: { cancellationReason: "Cancelled by the caller over the phone" },
          },
        );
      } catch (error) {
        if (error?.statusCode !== 404) throw error;
      }
      return { provider: "cal-com", providerEventId };
    },
  };
}

function normalizeBooking(booking, fallbackUid) {
  const value = Array.isArray(booking) ? booking[0] : booking;
  return {
    provider: "cal-com",
    providerEventId: value?.uid ?? fallbackUid,
  };
}

function requireEventTypeId(eventTypeId) {
  if (!eventTypeId) {
    throw providerError(
      "No Cal.com event type is selected for this agent",
      400,
      "provider_api_error",
    );
  }
}

async function requestJson(fetchImpl, url, {
  method = "GET",
  accessToken,
  version,
  body,
}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(version ? { "cal-api-version": version } : {}),
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
      throw providerError("Cal.com returned invalid JSON", 502, "provider_api_error");
    }
  }
  if (!response.ok) {
    throw providerError(
      value?.error?.message || value?.message || "Cal.com request failed",
      response.status,
      response.status === 401 ? "provider_unauthorized" : "provider_api_error",
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
