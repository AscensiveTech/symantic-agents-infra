import assert from "node:assert/strict";
import test from "node:test";

import { OUTSIDE_MESSAGE } from "../geo/coverage.mjs";
import { item, PLACES, ZONES } from "../geo/test-fixtures.mjs";
import { handleServiceArea } from "./service-area.mjs";

const BUSINESS_ADDRESS = "10901 Rhode Island Ave, Beltsville, MD 20705";
const BUSINESS = item({
  type: "PointAddress",
  title: BUSINESS_ADDRESS,
  region: ["MD", "Maryland"],
  subRegion: "Prince George's",
  locality: "Beltsville",
  postalCode: "20705",
  position: [-76.9286, 39.0348],
});

// Fake Amazon Location: answers by query text, records every request.
function fakePlaces(answers) {
  const calls = [];
  return {
    calls,
    async geocode(request) {
      calls.push(request);
      const answer = answers[request.text];
      if (answer instanceof Error) throw answer;
      return (answer ?? []).slice(0, request.maxResults ?? 5);
    },
  };
}

function storeWith({ configuration = {}, pendingConfiguration, workspaceProfile = {} } = {}) {
  return {
    async getAgent() {
      return { agentId: "agent-1", configuration, ...(pendingConfiguration ? { pendingConfiguration } : {}) };
    },
    async getBusinessProfile() {
      return workspaceProfile;
    },
  };
}

const call = (location, { store, places, ...input } = {}) =>
  handleServiceArea({ workspaceId: "ws-1", agentId: "agent-1", location, ...input }, { store, places });

test("zones come from the agent's published configuration, not the autosaved draft", async () => {
  const store = storeWith({
    configuration: { businessProfile: { address: BUSINESS_ADDRESS, serviceZones: [ZONES.montgomeryCounty] } },
    pendingConfiguration: { businessProfile: { serviceZones: [ZONES.virginia] } },
  });
  const places = fakePlaces({ [BUSINESS_ADDRESS]: [BUSINESS], "Silver Spring": [PLACES.silverSpringMd, PLACES.silverSpringPa] });
  const response = await call("Silver Spring", { store, places });
  assert.equal(response.status, "covered");
  assert.equal(response.matchedArea, "Montgomery County, MD");
  assert.equal(response.canonicalLocation.region, "Maryland");
});

test("the caller's words are geocoded near the business, within the countries it serves", async () => {
  const store = storeWith({
    configuration: { language: "es-419", businessProfile: { address: BUSINESS_ADDRESS, serviceZones: [ZONES.montgomeryCounty, ZONES.northernVirginia] } },
  });
  const places = fakePlaces({ [BUSINESS_ADDRESS]: [BUSINESS], "Arlington": [PLACES.arlingtonVa] });
  await call("Arlington", { store, places });
  const request = places.calls.find((entry) => entry.text === "Arlington");
  assert.deepEqual(request.biasPosition, [-76.9286, 39.0348]);
  assert.deepEqual(request.countries, ["USA"]);
  assert.equal(request.language, "es");
});

test("the business's own town and postal code are always covered", async () => {
  const store = storeWith({ configuration: { businessProfile: { address: BUSINESS_ADDRESS, serviceZones: [ZONES.virginia] } } });
  const beltsville = item({ title: "Beltsville, MD, United States", region: ["MD", "Maryland"], subRegion: "Prince George's", locality: "Beltsville", position: [-76.907, 39.03], mapView: [-76.95, 39.0, -76.86, 39.07] });
  const zip = item({ type: "PostalCode", title: "20705, Beltsville, MD, United States", region: ["MD", "Maryland"], locality: "Beltsville", postalCode: "20705", position: [-76.92, 39.04] });
  const places = fakePlaces({ [BUSINESS_ADDRESS]: [BUSINESS], Beltsville: [beltsville], "20705": [zip], Baltimore: [PLACES.baltimore] });
  for (const location of ["Beltsville", "20705"]) {
    const response = await call(location, { store, places });
    assert.equal(response.status, "covered", location);
    assert.equal(response.matchedBy, "business_location", location);
  }
  assert.equal((await call("Baltimore", { store, places })).status, "outside");
});

test("an agent published before map zones existed: its text list is geocoded and still works", async () => {
  const store = storeWith({ configuration: { businessProfile: { serviceAreas: ["Maryland", "Capitol Hill"] } } });
  const places = fakePlaces({
    Maryland: [PLACES.maryland],
    "Capitol Hill": [item({ type: "PointOfInterest", title: "Capitol Hill Bistro", region: ["DC", "District of Columbia"], position: [-77.0, 38.89] })],
    "Silver Spring": [PLACES.silverSpringMd],
    "Capitol Hill please": [],
    "Richmond, VA": [PLACES.richmondVa],
  });
  const serviceAreas = JSON.stringify(["Maryland", "Capitol Hill"]);
  assert.equal((await call("Silver Spring", { store, places, serviceAreas })).status, "covered");
  // Not a place the map knows - matched by the words, as before.
  assert.equal((await call("Capitol Hill please", { store, places, serviceAreas })).matchedArea, "Capitol Hill");
  const outside = await call("Richmond, VA", { store, places, serviceAreas });
  assert.equal(outside.status, "outside");
  assert.equal(outside.message, OUTSIDE_MESSAGE);
});

test("map zones replace an older text list", async () => {
  const store = storeWith({ configuration: { businessProfile: { serviceZones: [ZONES.virginia] } } });
  const places = fakePlaces({ "Silver Spring": [PLACES.silverSpringMd] });
  const response = await call("Silver Spring", { store, places, serviceAreas: JSON.stringify(["Maryland"]) });
  assert.equal(response.status, "outside");
  assert.ok(!places.calls.some((entry) => entry.text === "Maryland"));
});

test("malformed zones are skipped rather than failing the call", async () => {
  const store = storeWith({ configuration: { businessProfile: { serviceZones: [{ type: "polygon", coordinates: [[0, 0]] }, null, ZONES.maryland] } } });
  const places = fakePlaces({ Baltimore: [PLACES.baltimore] });
  assert.equal((await call("Baltimore", { store, places })).status, "covered");
});

test("a failed lookup is an error, never a guess", async () => {
  const store = storeWith({ configuration: { businessProfile: { serviceZones: [ZONES.maryland] } } });
  const places = fakePlaces({ Baltimore: Object.assign(new Error("throttled"), { name: "ThrottlingException" }) });
  await assert.rejects(() => call("Baltimore", { store, places }), /throttled/);
});

test("location is required", async () => {
  await assert.rejects(() => handleServiceArea({ workspaceId: "ws-1" }, { store: storeWith(), places: fakePlaces({}) }), /location is required/);
});
