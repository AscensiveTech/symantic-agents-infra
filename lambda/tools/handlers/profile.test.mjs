import assert from "node:assert/strict";
import test from "node:test";

import { effectiveProfile } from "./profile.mjs";

test("effectiveProfile preserves a valid per-agent timezone", () => {
  const profile = effectiveProfile(
    { configuration: { businessProfile: { timezone: "America/Chicago" } } },
    { timezone: "America/New_York" },
  );
  assert.equal(profile.timezone, "America/Chicago");
});

test("effectiveProfile normalizes invalid legacy timezones to UTC for calendar tools", () => {
  const profile = effectiveProfile(
    { configuration: { businessProfile: { timezone: "Mars/Olympus" } } },
    { timezone: "America/New_York" },
  );
  assert.equal(profile.timezone, "UTC");
});
