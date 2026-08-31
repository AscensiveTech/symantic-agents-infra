import assert from "node:assert/strict";
import test from "node:test";

import { formatBusinessHours, formatCurrentTime, isBusinessHours } from "./business-hours.mjs";

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function schedule(overrides = {}) {
  const base = Object.fromEntries(
    WEEK.map((key) => [key, { closed: false, open: "08:00", close: "17:00" }]),
  );
  return { ...base, ...overrides };
}

test("formatBusinessHours groups consecutive identical days", () => {
  const hours = schedule({
    sat: { closed: true, open: "09:00", close: "13:00" },
    sun: { closed: true, open: "09:00", close: "13:00" },
  });
  assert.equal(formatBusinessHours(hours), "Mon–Fri 8:00 AM–5:00 PM, Sat–Sun closed");
});

test("formatBusinessHours renders a lone open day and all-closed", () => {
  const soloSat = Object.fromEntries(
    WEEK.map((key) => [key, { closed: key !== "sat", open: "09:00", close: "13:00" }]),
  );
  assert.equal(
    formatBusinessHours(soloSat),
    "Mon–Fri closed, Sat 9:00 AM–1:00 PM, Sun closed",
  );

  const allClosed = Object.fromEntries(
    WEEK.map((key) => [key, { closed: true, open: "09:00", close: "17:00" }]),
  );
  assert.equal(formatBusinessHours(allClosed), "Closed");
});

test("isBusinessHours accepts a full schedule and rejects malformed input", () => {
  assert.equal(isBusinessHours(schedule()), true);
  assert.equal(isBusinessHours(null), false);
  assert.equal(isBusinessHours({}), false);
  const missing = schedule();
  delete missing.sun;
  assert.equal(isBusinessHours(missing), false);
  assert.equal(isBusinessHours(schedule({ mon: { closed: false, open: "8", close: "17:00" } })), false);
  assert.equal(
    isBusinessHours(schedule({ mon: { closed: "yes", open: "08:00", close: "17:00" } })),
    false,
  );
});

test("formatCurrentTime returns a readable string and tolerates a bad timezone", () => {
  assert.match(formatCurrentTime("America/New_York"), /\d/);
  assert.match(formatCurrentTime("Not/AZone"), /\d/);
  assert.match(formatCurrentTime(undefined), /\d/);
});
