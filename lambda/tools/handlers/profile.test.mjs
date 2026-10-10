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

test("effectiveProfile takes the agent's own Service Area summary and Exact Coverage over the workspace's", () => {
  const profile = effectiveProfile(
    { configuration: { businessProfile: { serviceAreaSummary: "Greater Dayton", serviceAreas: ["45402"] } } },
    { serviceAreaSummary: "Workspace summary", serviceAreas: ["Charleston, SC"] },
  );
  assert.equal(profile.serviceAreaSummary, "Greater Dayton");
  assert.deepEqual(profile.serviceAreas, ["45402"]);
});
