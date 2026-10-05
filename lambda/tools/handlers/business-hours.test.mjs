import assert from "node:assert/strict";
import test from "node:test";

import { enforceBusinessHours } from "./business-hours.mjs";

const open = (...intervals) => ({ closed: false, intervals: intervals.map(([o, c]) => ({ open: o, close: c })) });
const closed = { closed: true, intervals: [{ open: "09:00", close: "17:00" }] };
const allDay = { closed: false, allDay: true, intervals: [] };

const profile = {
  timezone: "America/New_York",
  businessHours: {
    mon: open(["08:00", "12:00"], ["13:00", "17:00"]),
    tue: open(["09:00", "17:00"]),
    wed: closed,
    thu: open(["09:00", "17:00"]),
    fri: open(["09:00", "17:00"]),
    sat: allDay,
    sun: allDay,
  },
};

// 2026-10-05 is a Monday. New York is UTC-4 in October.
const range = (startLocal, endLocal) => ({
  startTimeUtc: new Date(`${startLocal}-04:00`).toISOString(),
  endTimeUtc: new Date(`${endLocal}-04:00`).toISOString(),
  timezone: "America/New_York",
});
const code = (fn) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return error.code;
  }
};

test("a time inside one opening range passes; one straddling the lunch gap does not", () => {
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-05T09:00", "2026-10-05T10:00"))), "ok");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-05T11:30", "2026-10-05T12:30"))), "outside_business_hours");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-05T13:00", "2026-10-05T17:00"))), "ok");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-05T16:30", "2026-10-05T17:30"))), "outside_business_hours");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-05T07:00", "2026-10-05T07:30"))), "outside_business_hours");
});

test("closed days refuse, 24-hour days accept any time, including across midnight into another 24-hour day", () => {
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-07T10:00", "2026-10-07T10:30"))), "outside_business_hours");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-10T02:00", "2026-10-10T03:00"))), "ok");
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-10T23:30", "2026-10-11T00:30"))), "ok");
  // Friday 4:30 PM to Saturday: Friday closes at 5.
  assert.equal(code(() => enforceBusinessHours(profile, range("2026-10-09T16:30", "2026-10-10T00:30"))), "outside_business_hours");
});

test("closed holidays refuse; holidays with free-text hours and disabled holidays are not enforced here", () => {
  const withHolidays = {
    ...profile,
    holidaysEnabled: true,
    holidays: [
      { id: "a", name: "Columbus Day", date: "2026-10-12", closed: true },
      { id: "b", name: "Founders Day", date: "2026-10-13", closed: false, hours: "10 AM - 2 PM" },
      { id: "c", name: "Ignored", date: "2026-10-15", closed: true, disabled: true },
    ],
  };
  assert.equal(code(() => enforceBusinessHours(withHolidays, range("2026-10-12T10:00", "2026-10-12T10:30"))), "closed_holiday");
  assert.equal(code(() => enforceBusinessHours(withHolidays, range("2026-10-13T07:00", "2026-10-13T07:30"))), "ok");
  assert.equal(code(() => enforceBusinessHours(withHolidays, range("2026-10-15T10:00", "2026-10-15T10:30"))), "ok");
  // With the holiday setting off, the list is ignored entirely.
  assert.equal(code(() => enforceBusinessHours({ ...withHolidays, holidaysEnabled: false }, range("2026-10-12T10:00", "2026-10-12T10:30"))), "ok");
});

test("no structured hours (free text only) means no enforcement", () => {
  assert.equal(code(() => enforceBusinessHours({ timezone: "America/New_York", hours: "Mon-Fri 9-5" }, range("2026-10-07T03:00", "2026-10-07T03:30"))), "ok");
});

test("hours are read in the business's timezone", () => {
  // 9:00 AM Los Angeles is 12:00 PM New York - inside LA's hours.
  const la = { ...profile, timezone: "America/Los_Angeles", businessHours: { ...profile.businessHours, mon: open(["09:00", "10:00"]) } };
  const startUtc = new Date("2026-10-05T09:00-07:00").toISOString();
  const endUtc = new Date("2026-10-05T09:30-07:00").toISOString();
  assert.equal(code(() => enforceBusinessHours(la, { startTimeUtc: startUtc, endTimeUtc: endUtc, timezone: "America/Los_Angeles" })), "ok");
});
