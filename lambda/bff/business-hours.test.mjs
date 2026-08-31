import assert from "node:assert/strict";
import test from "node:test";

import { formatBusinessHours, formatCurrentTime, isBusinessHours } from "./business-hours.mjs";

const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function schedule(fn) {
  return Object.fromEntries(WEEK.map((key) => [key, fn(key)]));
}

const singleBlock = () =>
  schedule(() => ({ closed: false, intervals: [{ open: "08:00", close: "17:00" }] }));

test("formatBusinessHours groups consecutive identical days", () => {
  const hours = schedule((key) =>
    key === "sat" || key === "sun"
      ? { closed: true, intervals: [{ open: "09:00", close: "13:00" }] }
      : { closed: false, intervals: [{ open: "08:00", close: "17:00" }] },
  );
  assert.equal(formatBusinessHours(hours), "Mon–Fri 8:00 AM–5:00 PM; Sat–Sun closed");
});

test("formatBusinessHours renders split intervals and all-closed", () => {
  const split = schedule((key) =>
    key === "sun"
      ? { closed: true, intervals: [{ open: "09:00", close: "13:00" }] }
      : {
          closed: false,
          intervals: [
            { open: "08:00", close: "12:00" },
            { open: "13:00", close: "17:00" },
          ],
        },
  );
  assert.equal(
    formatBusinessHours(split),
    "Mon–Sat 8:00 AM–12:00 PM, 1:00 PM–5:00 PM; Sun closed",
  );

  assert.equal(
    formatBusinessHours(schedule(() => ({ closed: true, intervals: [{ open: "09:00", close: "17:00" }] }))),
    "Closed",
  );
});

test("isBusinessHours accepts a full schedule and rejects malformed input", () => {
  assert.equal(isBusinessHours(singleBlock()), true);
  assert.equal(isBusinessHours(null), false);
  assert.equal(isBusinessHours({}), false);
  const missing = singleBlock();
  delete missing.sun;
  assert.equal(isBusinessHours(missing), false);
  assert.equal(
    isBusinessHours(schedule(() => ({ closed: false, intervals: [] }))),
    false,
  );
  assert.equal(
    isBusinessHours(schedule(() => ({ closed: false, intervals: [{ open: "8", close: "17:00" }] }))),
    false,
  );
});

test("formatCurrentTime returns a readable string and tolerates a bad timezone", () => {
  assert.match(formatCurrentTime("America/New_York"), /\d/);
  assert.match(formatCurrentTime("Not/AZone"), /\d/);
  assert.match(formatCurrentTime(undefined), /\d/);
});
