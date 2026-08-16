import { ToolRequestError, requireString } from "./errors.mjs";

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function resolveTimeRange(input, timezone, now = () => new Date()) {
  assertTimezone(timezone);
  const start = resolveDateTime(
    requireString(input.startTime, "startTime"),
    timezone,
    now,
  );
  let end;
  if (typeof input.endTime === "string" && input.endTime.trim()) {
    end = resolveDateTime(input.endTime, timezone, now);
  } else {
    const durationMinutes = input.durationMinutes === undefined
      ? 30
      : Number(input.durationMinutes);
    if (
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0 ||
      durationMinutes > 1440
    ) {
      throw new ToolRequestError(
        "durationMinutes must be between 1 and 1440",
      );
    }
    end = new Date(start.getTime() + durationMinutes * 60_000);
  }
  if (end.getTime() <= start.getTime()) {
    throw new ToolRequestError("endTime must be after startTime");
  }
  return {
    startTimeUtc: start.toISOString(),
    endTimeUtc: end.toISOString(),
    timezone,
  };
}

export function resolveDateTime(value, timezone, now = () => new Date()) {
  const text = value.trim();
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    return validDate(new Date(text), "Invalid date/time");
  }

  const localIso = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (localIso) {
    return zonedPartsToUtc({
      year: Number(localIso[1]),
      month: Number(localIso[2]),
      day: Number(localIso[3]),
      hour: Number(localIso[4]),
      minute: Number(localIso[5]),
      second: Number(localIso[6] ?? 0),
      millisecond: Number((localIso[7] ?? "0").padEnd(3, "0")),
    }, timezone);
  }

  const relative = text.match(
    /^(today|tomorrow|day after tomorrow|(?:next\s+)?(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?))(?:\s+at)?\s+(.+)$/i,
  );
  if (!relative) {
    throw new ToolRequestError(
      "startTime/endTime must be ISO 8601 or a supported relative time",
    );
  }
  const current = zonedParts(validDate(new Date(now()), "Invalid current time"), timezone);
  const date = {
    year: current.year,
    month: current.month,
    day: current.day,
  };
  const dayPhrase = relative[1].toLowerCase();
  let daysToAdd = 0;
  if (dayPhrase === "tomorrow") daysToAdd = 1;
  else if (dayPhrase === "day after tomorrow") daysToAdd = 2;
  else if (dayPhrase !== "today") {
    const weekdayName = dayPhrase.replace(/^next\s+/, "");
    const normalized = Object.keys(WEEKDAYS).find((name) =>
      name.startsWith(weekdayName.slice(0, 3))
    );
    const target = WEEKDAYS[normalized];
    const currentWeekday = new Date(
      Date.UTC(date.year, date.month - 1, date.day),
    ).getUTCDay();
    daysToAdd = (target - currentWeekday + 7) % 7;
    if (daysToAdd === 0 || dayPhrase.startsWith("next ")) daysToAdd ||= 7;
  }
  const targetDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  targetDate.setUTCDate(targetDate.getUTCDate() + daysToAdd);
  const time = parseClockTime(relative[2]);
  return zonedPartsToUtc({
    year: targetDate.getUTCFullYear(),
    month: targetDate.getUTCMonth() + 1,
    day: targetDate.getUTCDate(),
    ...time,
    second: 0,
    millisecond: 0,
  }, timezone);
}

function parseClockTime(value) {
  const match = value.trim().match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (!match) throw new ToolRequestError("Invalid relative clock time");
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour === 0 && meridiem) {
    throw new ToolRequestError("Invalid relative clock time");
  }
  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

function zonedPartsToUtc(parts, timezone) {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let timestamp = desiredAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      parts.millisecond,
    );
    const correction = desiredAsUtc - actualAsUtc;
    timestamp += correction;
    if (correction === 0) break;
  }
  const result = new Date(timestamp);
  const roundTrip = zonedParts(result, timezone);
  if (
    roundTrip.year !== parts.year ||
    roundTrip.month !== parts.month ||
    roundTrip.day !== parts.day ||
    roundTrip.hour !== parts.hour ||
    roundTrip.minute !== parts.minute
  ) {
    throw new ToolRequestError(
      "The requested local time does not exist in the workspace timezone",
    );
  }
  return result;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new ToolRequestError("Workspace timezone is invalid");
  }
}

function validDate(value, message) {
  if (Number.isNaN(value.getTime())) throw new ToolRequestError(message);
  return value;
}
