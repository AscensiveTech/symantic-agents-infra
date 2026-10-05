import { ToolRequestError } from "./errors.mjs";

// Business hours and closed holidays, enforced by the calendar tools - not
// only stated in the prompt - so a time outside them is never reported as
// available or booked, whatever the model asks for.
//
// Reads the same structured shape as lambda/bff/business-hours.mjs
// (frontend lib/domain/business-hours.ts): each weekday is closed, open all
// day, or open for one or more HH:MM intervals. The appointment itself (not
// its hidden before/after buffers) must fit inside one interval.
//
// Deliberately permissive where the data can't be read reliably: no
// structured hours (only free text), or a holiday with free-text special
// hours, means no enforcement for that day - the prompt still covers it.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function enforceBusinessHours(profile, range) {
  const hours = profile?.businessHours;
  if (!isWeeklyHours(hours)) return;
  const timezone = range.timezone || profile?.timezone || "UTC";
  const start = localParts(range.startTimeUtc, timezone);
  const end = localParts(range.endTimeUtc, timezone);
  if (!start || !end) return;

  const holiday = holidayOn(profile, start.date);
  if (holiday?.closed) {
    throw outside(`The business is closed on ${holiday.name}.`, "closed_holiday");
  }
  if (holiday) return;

  const day = hours[DAY_KEYS[start.weekday]];
  // Crossing midnight is only fine when both days are open around the clock.
  if (end.date !== start.date && !(end.minutes === 0 && dayAfter(start.date) === end.date)) {
    const nextDay = hours[DAY_KEYS[end.weekday]];
    if (day.allDay === true && nextDay?.allDay === true) return;
    throw outside("That time runs past closing.");
  }
  if (day.allDay === true) return;
  if (day.closed) throw outside("The business is closed that day.");
  const startMin = start.minutes;
  const endMin = end.date === start.date ? end.minutes : 24 * 60;
  const fits = day.intervals.some(({ open, close }) => {
    const openMin = toMinutes(open);
    let closeMin = toMinutes(close);
    if (closeMin <= openMin) closeMin = 24 * 60;
    return startMin >= openMin && endMin <= closeMin;
  });
  if (!fits) throw outside("That time is outside business hours.");
}

function outside(message, code = "outside_business_hours") {
  return new ToolRequestError(`${message} Please choose a time within business hours.`, { statusCode: 409, code });
}

function holidayOn(profile, date) {
  if (profile?.holidaysEnabled !== true || !Array.isArray(profile?.holidays)) return null;
  return profile.holidays.find((holiday) => !holiday?.disabled && holiday?.date === date) ?? null;
}

function isWeeklyHours(value) {
  if (!value || typeof value !== "object") return false;
  return DAY_KEYS.every((key) => {
    const day = value[key];
    if (!day || typeof day.closed !== "boolean") return false;
    if (day.allDay === true) return true;
    return Array.isArray(day.intervals) && day.intervals.every((interval) =>
      TIME.test(interval?.open ?? "") && TIME.test(interval?.close ?? ""));
  });
}

function localParts(iso, timezone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date).map((part) => [part.type, part.value]));
  } catch {
    return null;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function dayAfter(isoDate) {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function toMinutes(hhmm) {
  const [, hour, minute] = TIME.exec(hhmm);
  return Number(hour) * 60 + Number(minute);
}
