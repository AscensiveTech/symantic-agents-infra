// Reads a Cal.com account with the customer's own API key: who it belongs
// to, and which event types (personal and team) it can book. Used only when
// connecting or refreshing - the tools Lambda does the booking itself.
const API_BASE = "https://api.cal.com/v2";
const EVENT_TYPES_API_VERSION = "2026-06-12";
const MAX_TEAMS = 10;
export const MAX_CAL_COM_EVENT_TYPES = 50;

export class CalComKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CalComKeyError";
  }
}

export function createCalComAccountClient({ fetchImpl = globalThis.fetch } = {}) {
  async function getJson(path, apiKey, version) {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(version ? { "cal-api-version": version } : {}),
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new CalComKeyError("Cal.com rejected that API key");
    }
    if (!response.ok) {
      const error = new Error(`Cal.com request failed (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    return response.json();
  }

  return {
    async getProfile(apiKey) {
      const body = await getJson("/me", apiKey);
      return {
        email: typeof body?.data?.email === "string" ? body.data.email : null,
        timeZone: typeof body?.data?.timeZone === "string" ? body.data.timeZone : null,
      };
    },

    // Personal event types always; team event types for up to 10 teams the
    // key's owner belongs to. A team that can't be read is skipped rather
    // than failing the whole connection.
    async listEventTypes(apiKey) {
      const personal = await getJson("/event-types", apiKey, EVENT_TYPES_API_VERSION);
      const eventTypes = toEventTypes(personal?.data);
      let teams = [];
      try {
        const body = await getJson("/teams", apiKey);
        teams = Array.isArray(body?.data) ? body.data.slice(0, MAX_TEAMS) : [];
      } catch (error) {
        if (error instanceof CalComKeyError) throw error;
      }
      for (const team of teams) {
        if (!team?.id) continue;
        try {
          const body = await getJson(
            `/teams/${encodeURIComponent(team.id)}/event-types`,
            apiKey,
            EVENT_TYPES_API_VERSION,
          );
          eventTypes.push(...toEventTypes(body?.data, team.name));
        } catch (error) {
          if (error instanceof CalComKeyError) throw error;
        }
      }
      const seen = new Set();
      return eventTypes
        .filter((eventType) => !seen.has(eventType.id) && seen.add(eventType.id))
        .slice(0, MAX_CAL_COM_EVENT_TYPES);
    },
  };
}

function toEventTypes(list, teamName) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && (typeof item.id === "number" || typeof item.id === "string"))
    .map((item) => ({
      id: String(item.id),
      name: String(item.title ?? item.slug ?? item.id).slice(0, 120),
      ...(Number.isFinite(Number(item.lengthInMinutes))
        ? { lengthInMinutes: Number(item.lengthInMinutes) }
        : {}),
      ...(typeof teamName === "string" && teamName ? { teamName: teamName.slice(0, 120) } : {}),
    }));
}
