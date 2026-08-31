// Structured weekly business hours — minimal port of the frontend helper at
// symantic-agents-frontend/lib/domain/business-hours.ts. Keep the two in sync
// (same grouped output string). `profile.hours` (free text) stays the source of
// truth; `profile.businessHours`, when present and valid, is preferred for the
// generated agent prompt.

const WEEKDAYS = [
  { key: "mon", short: "Mon" },
  { key: "tue", short: "Tue" },
  { key: "wed", short: "Wed" },
  { key: "thu", short: "Thu" },
  { key: "fri", short: "Fri" },
  { key: "sat", short: "Sat" },
  { key: "sun", short: "Sun" },
];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isDayHours(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.closed === "boolean" &&
    typeof value.open === "string" &&
    TIME_PATTERN.test(value.open) &&
    typeof value.close === "string" &&
    TIME_PATTERN.test(value.close)
  );
}

export function isBusinessHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return WEEKDAYS.every(({ key }) => isDayHours(value[key]));
}

function formatTime12h(hhmm) {
  const [hourText, minuteText] = hhmm.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${displayHour}:00 ${period}`
    : `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function daySummary(day) {
  return day.closed ? "closed" : `${formatTime12h(day.open)}–${formatTime12h(day.close)}`;
}

export function formatBusinessHours(hours) {
  if (WEEKDAYS.every(({ key }) => hours[key].closed)) return "Closed";

  const groups = [];
  for (const { key, short } of WEEKDAYS) {
    const summary = daySummary(hours[key]);
    const last = groups[groups.length - 1];
    if (last && last.summary === summary) {
      last.endShort = short;
    } else {
      groups.push({ startShort: short, endShort: short, summary });
    }
  }

  return groups
    .map(({ startShort, endShort, summary }) => {
      const label = startShort === endShort ? startShort : `${startShort}–${endShort}`;
      return `${label} ${summary}`;
    })
    .join(", ");
}

// Business-local clock string for a call's dynamic variables — lets the agent
// answer "are you open right now?". Falls back to UTC on an invalid timezone.
export function formatCurrentTime(timezone) {
  const options = {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timezone || "UTC" }).format(
      new Date(),
    );
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date());
  }
}
