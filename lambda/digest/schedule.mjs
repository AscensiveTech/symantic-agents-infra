export const DIGEST_FREQUENCIES = [
  "every_5_minutes",
  "every_10_minutes",
  "every_30_minutes",
  "hourly",
  "every_6_hours",
  "daily",
  "weekly",
];

export const DEFAULT_DIGEST_SETTINGS = Object.freeze({
  enabled: false,
  frequency: "daily",
  sendHour: 8,
  weekday: 1,
  timezone: "UTC",
  includeTranscripts: true,
  extraRecipients: [],
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
// The schedule ticks every 5 minutes. A few minutes of slack absorbs
// EventBridge jitter, so an hourly summary never skips a tick because it
// fired seconds early. The short intervals get a much smaller slack so they
// stay meaningfully faster than the next interval up.
const SLACK_MS = 5 * 60_000;
const SHORT_SLACK_MS = 15_000;

export function isValidTimezone(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeDigestSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const hour = Number(source.sendHour);
  const weekday = Number(source.weekday);
  return {
    enabled: source.enabled === true,
    frequency: DIGEST_FREQUENCIES.includes(source.frequency)
      ? source.frequency
      : DEFAULT_DIGEST_SETTINGS.frequency,
    sendHour: Number.isInteger(hour) && hour >= 0 && hour <= 23
      ? hour
      : DEFAULT_DIGEST_SETTINGS.sendHour,
    weekday: Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
      ? weekday
      : DEFAULT_DIGEST_SETTINGS.weekday,
    timezone: isValidTimezone(source.timezone) ? source.timezone : DEFAULT_DIGEST_SETTINGS.timezone,
    includeTranscripts: source.includeTranscripts !== false,
    extraRecipients: Array.isArray(source.extraRecipients)
      ? source.extraRecipients.filter((item) => typeof item === "string")
      : [],
  };
}

export function localParts(date, timezone) {
  const zone = isValidTimezone(timezone) ? timezone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value) % 24;
  const weekday = WEEKDAYS.indexOf(parts.find((part) => part.type === "weekday")?.value);
  return { hour, weekday };
}

// Due-ness is measured from the cursor (the end of the last window covered),
// so a missed tick never loses calls - the next summary simply covers more.
export function isDigestDue(settings, cursorIso, now) {
  if (settings?.enabled !== true) return false;
  const cursor = Date.parse(cursorIso ?? "");
  if (!Number.isFinite(cursor)) return false;
  const elapsed = now.getTime() - cursor;
  switch (settings.frequency) {
    case "every_5_minutes":
      return elapsed >= 5 * MINUTE_MS - SHORT_SLACK_MS;
    case "every_10_minutes":
      return elapsed >= 10 * MINUTE_MS - SHORT_SLACK_MS;
    case "every_30_minutes":
      return elapsed >= 30 * MINUTE_MS - SHORT_SLACK_MS;
    case "hourly":
      return elapsed >= HOUR_MS - SLACK_MS;
    case "every_6_hours":
      return elapsed >= 6 * HOUR_MS - SLACK_MS;
    case "daily": {
      const { hour } = localParts(now, settings.timezone);
      return hour === settings.sendHour && elapsed >= 12 * HOUR_MS;
    }
    case "weekly": {
      const { hour, weekday } = localParts(now, settings.timezone);
      return weekday === settings.weekday &&
        hour === settings.sendHour &&
        elapsed >= 3 * 24 * HOUR_MS;
    }
    default:
      return false;
  }
}
