import assert from "node:assert/strict";
import test from "node:test";

import { handleServiceArea } from "./service-area.mjs";

function input(overrides = {}) {
  return {
    location: "Arlington, VA",
    serviceAreas: JSON.stringify(["Arlington, VA", "Alexandria, VA", "22201"]),
    ...overrides,
  };
}

test("exact city match", async () => {
  const result = await handleServiceArea(input({ location: "Alexandria, VA" }));
  assert.equal(result.matched, true);
  assert.equal(result.ok, true);
});

test("case and whitespace insensitive", async () => {
  const result = await handleServiceArea(input({ location: "  ARLINGTON,   va " }));
  assert.equal(result.matched, true);
});

test("caller phrasing with extra words around a listed city still matches (whole-word substring)", async () => {
  const result = await handleServiceArea(input({ location: "I'm calling from near Arlington today" }));
  assert.equal(result.matched, true);
});

test("a listed city that's a substring of another word does not false-positive", async () => {
  // "Arlington" must not match inside an unrelated longer word.
  const result = await handleServiceArea(input({ location: "Darlingtonville" }));
  assert.equal(result.matched, false);
});

test("ZIP exact match", async () => {
  const result = await handleServiceArea(input({ location: "22201" }));
  assert.equal(result.matched, true);
});

test("ZIP+4 on the configured side still matches the caller's plain 5-digit ZIP", async () => {
  const result = await handleServiceArea(input({
    location: "22201",
    serviceAreas: JSON.stringify(["22201-1234"]),
  }));
  assert.equal(result.matched, true);
});

test("ZIP+4 spoken by the caller still matches a plain 5-digit configured ZIP", async () => {
  const result = await handleServiceArea(input({
    location: "22201-1234",
    serviceAreas: JSON.stringify(["22201"]),
  }));
  assert.equal(result.matched, true);
});

test("a clear non-match returns matched:false with no message, not an error", async () => {
  const result = await handleServiceArea(input({ location: "Seattle, WA" }));
  assert.deepEqual(result, { ok: true, matched: false, message: "" });
});

test("a broad label like 'DC metro area' matches when the caller says the same phrase", async () => {
  const result = await handleServiceArea(input({
    location: "I think I'm in the DC metro area",
    serviceAreas: JSON.stringify(["DC metro area"]),
  }));
  assert.equal(result.matched, true);
});

test("location is required", async () => {
  await assert.rejects(
    () => handleServiceArea({ serviceAreas: JSON.stringify(["Arlington, VA"]) }),
    /location is required/,
  );
});

test("malformed serviceAreas JSON is treated as an empty list, not a crash", async () => {
  const result = await handleServiceArea({ location: "Arlington, VA", serviceAreas: "not json" });
  assert.equal(result.matched, false);
});
