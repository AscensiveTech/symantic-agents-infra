import assert from "node:assert/strict";
import test from "node:test";

import { createGeoService, createRateLimiter, handleGeoRoute, toZonePlace } from "./geo.mjs";
import { formatDistance, MAX_POLYGON_VERTICES, MAX_RADIUS_METERS, MAX_ZONES, sanitizeServiceZones, spokenZoneName } from "./voice-agent/service-zones.mjs";

function fakeSend(responses) {
  const calls = [];
  const send = async (operation, input) => {
    calls.push({ operation, input });
    const response = responses[operation];
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(input) : response;
  };
  return { send, calls };
}

const json = (statusCode, body) => ({ statusCode, body });

const MONTGOMERY = {
  PlaceId: "montgomery",
  PlaceType: "SubRegion",
  Title: "Montgomery, MD, United States",
  Address: { Country: { Code3: "USA", Code2: "US", Name: "United States" }, Region: { Code: "MD", Name: "Maryland" }, SubRegion: { Name: "Montgomery" } },
  Position: [-77.2, 39.14],
  MapView: [-77.52745, 38.93443, -76.88783, 39.35414],
};

test("area search merges counties from Suggest with postal codes from Autocomplete, areas only", async () => {
  const { send, calls } = fakeSend({
    Suggest: { ResultItems: [
      { Title: "Montgomery, MD, United States", Place: { PlaceId: "montgomery", PlaceType: "SubRegion" } },
      { Title: "Montgomery County Government", Place: { PlaceId: "poi", PlaceType: "PointOfInterest" } },
      { Title: "montgomery county pizza", SuggestResultItemType: "Query" },
    ] },
    Autocomplete: { ResultItems: [
      { PlaceId: "zip", PlaceType: "PostalCode", Title: "United States, MD, 20910, Silver Spring" },
      { PlaceId: "montgomery", PlaceType: "SubRegion", Title: "duplicate" },
      { PlaceId: "street", PlaceType: "Street", Title: "Montgomery Ave" },
    ] },
  });
  const geo = createGeoService({ send });
  const results = await geo.search({ text: " Montgomery ", biasPosition: [-77, 39], countries: ["USA", "bad"], language: "en" });
  assert.deepEqual(results, [
    { placeId: "montgomery", placeType: "SubRegion", title: "Montgomery, MD, United States" },
    { placeId: "zip", placeType: "PostalCode", title: "United States, MD, 20910, Silver Spring" },
  ]);
  const autocomplete = calls.find((call) => call.operation === "Autocomplete").input;
  assert.equal(autocomplete.QueryText, "Montgomery");
  assert.deepEqual(autocomplete.BiasPosition, [-77, 39]);
  assert.deepEqual(autocomplete.Filter, { IncludePlaceTypes: ["Country", "Region", "Locality", "PostalCode"], IncludeCountries: ["USA"] });
  assert.equal(await geo.search({ text: "   " }).then((list) => list.length), 0);
});

test("address search (a radius center) returns addresses as-is", async () => {
  const { send, calls } = fakeSend({ Autocomplete: { ResultItems: [{ PlaceId: "a", PlaceType: "PointAddress", Title: "10901 Rhode Island Ave" }] } });
  const results = await createGeoService({ send }).search({ text: "10901 Rhode", mode: "address" });
  assert.deepEqual(results, [{ placeId: "a", placeType: "PointAddress", title: "10901 Rhode Island Ave" }]);
  assert.deepEqual(calls.map((call) => call.operation), ["Autocomplete"]);
  assert.deepEqual(calls[0].input.BiasPosition, [0, 0]);
});

test("a picked place is fetched for storage and turned into zone fields", async () => {
  const { send, calls } = fakeSend({ GetPlace: MONTGOMERY });
  const result = await createGeoService({ send }).place({ placeId: "montgomery" });
  assert.equal(calls[0].input.IntendedUse, "Storage");
  assert.deepEqual(result, {
    label: "Montgomery County, Maryland",
    place: {
      placeId: "montgomery",
      placeType: "SubRegion",
      countryCode: "USA",
      countryName: "United States",
      regionCode: "MD",
      regionName: "Maryland",
      subRegionName: "Montgomery",
      locality: null,
      district: null,
      postalCode: null,
    },
    position: [-77.2, 39.14],
    mapView: [-77.52745, 38.93443, -76.88783, 39.35414],
  });
  assert.equal(toZonePlace({ ...MONTGOMERY, PlaceType: "PointOfInterest" }), null);
  // An address can't be a place zone, but its position can center a radius.
  const address = await createGeoService({ send: fakeSend({ GetPlace: { PlaceId: "a", PlaceType: "PointAddress", Title: "10901 Rhode Island Ave, Beltsville, MD 20705", Position: [-76.93, 39.03] } }).send }).place({ placeId: "a" });
  assert.deepEqual(address, { label: "10901 Rhode Island Ave, Beltsville, MD 20705", place: null, position: [-76.93, 39.03], mapView: null });
  // US counties say what they are; Louisiana parishes and other countries' names as given.
  const county = (name, code, country = "USA") => toZonePlace({ PlaceId: "c", PlaceType: "SubRegion", Title: name, Address: { Country: { Code3: country, Name: "X" }, Region: { Code: code, Name: "R" }, SubRegion: { Name: name } } }).label;
  assert.equal(county("Orleans", "LA"), "Orleans Parish, R");
  assert.equal(county("Baltimore (City)", "MD"), "Baltimore (City), R");
  assert.equal(county("Lancashire", "ENG", "GBR"), "Lancashire, R");
  // A terse Title ("MD, United States") is replaced by the spelled-out name.
  assert.equal(toZonePlace({ PlaceId: "md", PlaceType: "Region", Title: "MD, United States", Address: { Country: { Code3: "USA", Name: "United States" }, Region: { Code: "MD", Name: "Maryland" } } }).label, "Maryland, United States");
});

test("reverse lookup (a drawn shape's country and region) is also for storage", async () => {
  const { send, calls } = fakeSend({ ReverseGeocode: { ResultItems: [{ Title: "Arlington, VA", Address: { Country: { Code3: "USA" }, Region: { Code: "VA", Name: "Virginia" }, Locality: "Arlington" } }] } });
  const result = await createGeoService({ send }).reverse({ position: [-77.1, 38.88] });
  assert.equal(calls[0].input.IntendedUse, "Storage");
  assert.deepEqual(result, { title: "Arlington, VA", locality: "Arlington", area: { countryCode: "USA", regionCode: "VA", regionName: "Virginia" } });
  assert.equal(await createGeoService({ send }).reverse({ position: [500, 0] }), null);
});

test("map config hands out the restricted maps key, cached for an hour", async () => {
  let clock = 0;
  const { send, calls } = fakeSend({ DescribeKey: { Key: "v1.public.abc" } });
  const geo = createGeoService({ send, region: "us-east-1", mapsKeyName: "maps-key", now: () => clock });
  assert.deepEqual(await geo.config(), {
    region: "us-east-1",
    mapStyleUrl: "https://maps.geo.us-east-1.amazonaws.com/v2/styles/Standard/descriptor?key=v1.public.abc",
  });
  await geo.config();
  assert.equal(calls.length, 1);
  clock = 61 * 60 * 1000;
  await geo.config();
  assert.equal(calls.length, 2);
  assert.equal(await createGeoService({ send, region: "us-east-1", mapsKeyName: "" }).config(), null);
});

test("route errors become friendly statuses, never a stack trace", async () => {
  const throttled = createGeoService({ send: fakeSend({ Suggest: Object.assign(new Error("slow down"), { name: "ThrottlingException" }), Autocomplete: {} }).send });
  assert.equal((await handleGeoRoute({ path: "/workspaces/me/geo/search", method: "POST", body: { text: "x" }, geo: throttled, json })).statusCode, 429);
  const unset = createGeoService({ send: fakeSend({}).send, mapsKeyName: "" });
  assert.equal((await handleGeoRoute({ path: "/workspaces/me/geo/config", method: "GET", geo: unset, json })).statusCode, 503);
  assert.equal((await handleGeoRoute({ path: "/workspaces/me/geo/nope", method: "GET", geo: unset, json })).statusCode, 404);
});

test("service zones are shape-checked and bounded", () => {
  const place = { type: "place", label: "Montgomery County", place: { placeType: "SubRegion", countryCode: "USA", subRegionName: "Montgomery", regionCode: "MD", junk: "x" }, position: [-77.2000004, 39.14] };
  const [saved] = sanitizeServiceZones([place]);
  assert.equal(saved.place.junk, undefined);
  assert.deepEqual(saved.position, [-77.2, 39.14]);
  assert.match(saved.id, /^zone-/);

  // Invalid zones are dropped.
  assert.deepEqual(sanitizeServiceZones([
    { type: "place", place: { placeType: "PointOfInterest", countryCode: "USA" } },
    { type: "place", place: { placeType: "Locality", countryCode: "USA" } },
    { type: "radius", center: [999, 0], radiusMeters: 1000 },
    { type: "polygon", coordinates: [[0, 0], [1, 1]] },
    { type: "circle" },
    null,
  ]), []);

  // Radius is clamped; polygon rings are stored open.
  const [radius, polygon] = sanitizeServiceZones([
    { type: "radius", center: [-77, 39], radiusMeters: 10_000_000, unit: "mi" },
    { type: "polygon", coordinates: [[0, 0], [1, 0], [1, 1], [0, 0]] },
  ]);
  assert.equal(radius.radiusMeters, MAX_RADIUS_METERS);
  assert.equal(radius.unit, "mi");
  assert.deepEqual(polygon.coordinates, [[0, 0], [1, 0], [1, 1]]);

  assert.equal(sanitizeServiceZones([{ type: "polygon", coordinates: Array.from({ length: MAX_POLYGON_VERTICES + 1 }, (_, i) => [i / 1000, (i % 2) / 1000]) }]).length, 0);
  assert.equal(sanitizeServiceZones(Array.from({ length: MAX_ZONES + 5 }, () => ({ type: "radius", center: [0, 0], radiusMeters: 1000 }))).length, MAX_ZONES);
});

test("map search is rate limited per workspace; the map config never is", async () => {
  let clock = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
  const geo = { search: async () => [], config: async () => ({ region: "us-east-1", mapStyleUrl: "x" }) };
  const call = (path, workspaceId, method = "POST") => handleGeoRoute({ path, method, body: { text: "a" }, geo, json, workspaceId, allow });
  assert.equal((await call("/workspaces/me/geo/search", "ws-a")).statusCode, 200);
  assert.equal((await call("/workspaces/me/geo/search", "ws-a")).statusCode, 200);
  assert.equal((await call("/workspaces/me/geo/search", "ws-a")).statusCode, 429);
  assert.equal((await call("/workspaces/me/geo/search", "ws-b")).statusCode, 200);
  assert.equal((await call("/workspaces/me/geo/config", "ws-a", "GET")).statusCode, 200);
  clock = 1001;
  assert.equal((await call("/workspaces/me/geo/search", "ws-a")).statusCode, 200);
});

test("a zone is spoken with a radius's distance; placeholder outline names say nothing", () => {
  assert.equal(spokenZoneName({ type: "place", label: "Montgomery County, Maryland", place: {} }), "Montgomery County, Maryland");
  assert.equal(spokenZoneName({ type: "radius", label: "Silver Spring", radiusMeters: 16093, unit: "mi" }), "within 10 miles of Silver Spring");
  assert.equal(spokenZoneName({ type: "radius", label: "Lyon", radiusMeters: 2500, unit: "km" }), "within 2.5 km of Lyon");
  assert.equal(spokenZoneName({ type: "polygon", label: "Northern Virginia" }), "Northern Virginia");
  assert.equal(spokenZoneName({ type: "polygon", label: "Drawn area 2" }), "");
  assert.equal(spokenZoneName({ type: "radius", label: "" }), "");
  assert.equal(formatDistance(1609, "mi"), "1 mile");
  assert.equal(formatDistance(40234, "mi"), "25 miles");
  assert.equal(formatDistance(500_000, "km"), "500 km");
});
