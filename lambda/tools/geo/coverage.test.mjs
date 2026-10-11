import assert from "node:assert/strict";
import test from "node:test";

import { COVERED_MESSAGE, OUTSIDE_MESSAGE, checkCoverage, distanceMeters, normalizeGeocodeItem, pointInPolygon, zoneVerdict } from "./coverage.mjs";
import { PLACES, ZONES } from "./test-fixtures.mjs";

const result = (item) => normalizeGeocodeItem(item);
const geocodeTo = (...items) => async () => items;
const check = (zones, items, options = {}) => checkCoverage({ location: "somewhere", zones, geocode: geocodeTo(...items), ...options });

// --- named places: matched by address components ------------------------------

test("a region covers every town, county and postal code in it", () => {
  for (const place of [PLACES.silverSpringMd, PLACES.zip20910, PLACES.montgomeryCounty, PLACES.baltimore, PLACES.zip20910plus4]) {
    assert.equal(zoneVerdict(ZONES.maryland, result(place)), "covered", place.Title);
  }
  assert.equal(zoneVerdict(ZONES.maryland, result(PLACES.arlingtonVa)), "outside");
  // Region codes, not names-in-text: West Virginia is never Virginia.
  assert.equal(zoneVerdict(ZONES.virginia, result(PLACES.morgantownWv)), "outside");
  assert.equal(zoneVerdict(ZONES.virginia, result(PLACES.richmondVa)), "covered");
});

test("a county covers its towns and postal codes; a whole region named against it is partial", () => {
  assert.equal(zoneVerdict(ZONES.montgomeryCounty, result(PLACES.silverSpringMd)), "covered");
  assert.equal(zoneVerdict(ZONES.montgomeryCounty, result(PLACES.zip20910)), "covered");
  assert.equal(zoneVerdict(ZONES.montgomeryCounty, result(PLACES.baltimore)), "outside");
  assert.equal(zoneVerdict(ZONES.montgomeryCounty, result(PLACES.maryland)), "partial");
});

test("a town covers its postal codes and addresses; the same town name in another region is outside", () => {
  assert.equal(zoneVerdict(ZONES.silverSpring, result(PLACES.zip20910)), "covered");
  assert.equal(zoneVerdict(ZONES.silverSpring, result(PLACES.zip20910plus4)), "covered");
  assert.equal(zoneVerdict(ZONES.silverSpring, result(PLACES.silverSpringPa)), "outside");
  assert.equal(zoneVerdict(ZONES.silverSpring, result(PLACES.montgomeryCounty)), "partial");
});

test("postal codes: ZIP+4 matches its five-digit base, a UK outward code covers its full postcodes", () => {
  assert.equal(zoneVerdict(ZONES.zip20910, result(PLACES.zip20910plus4)), "covered");
  assert.equal(zoneVerdict(ZONES.zip20910, result(PLACES.zip20910)), "covered");
  assert.equal(zoneVerdict(ZONES.manchesterM1, result(PLACES.manchesterM1)), "covered");
  assert.equal(zoneVerdict(ZONES.manchesterM1, result(PLACES.salfordM5)), "outside");
  // A town that contains the postal code: only part of it is served.
  assert.equal(zoneVerdict(ZONES.zip20910, result(PLACES.silverSpringMd)), "partial");
});

test("a country covers everything in it, and nothing outside it", () => {
  assert.equal(zoneVerdict(ZONES.usa, result(PLACES.arlingtonTx)), "covered");
  assert.equal(zoneVerdict(ZONES.usa, result(PLACES.bengaluru)), "outside");
});

test("international places match on their own components", () => {
  assert.equal(zoneVerdict(ZONES.bengaluru, result(PLACES.bengaluru)), "covered");
  assert.equal(zoneVerdict(ZONES.bengaluru, result(PLACES.mysuru)), "outside");
  assert.equal(zoneVerdict(ZONES.paris, result(PLACES.parisDistrict)), "covered");
  assert.equal(zoneVerdict(ZONES.paris, result(PLACES.lyon)), "outside");
});

// --- radius and drawn outlines: matched by position ----------------------------

test("geometry helpers", () => {
  const dcToBaltimore = distanceMeters([-77.0369, 38.9072], [-76.6122, 39.2904]);
  assert.ok(dcToBaltimore > 55000 && dcToBaltimore < 58000, String(dcToBaltimore));
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([15, 5], square), false);
});

test("a radius covers addresses and postal codes inside it and towns centered inside it", () => {
  assert.equal(zoneVerdict(ZONES.radiusSilverSpring, result(PLACES.zip20910plus4)), "covered");
  assert.equal(zoneVerdict(ZONES.radiusSilverSpring, result(PLACES.silverSpringMd)), "covered");
  assert.equal(zoneVerdict(ZONES.radiusSilverSpring, result(PLACES.arlingtonVa)), "covered");
  assert.equal(zoneVerdict(ZONES.radiusSilverSpring, result(PLACES.baltimore)), "outside");
  // A whole state around it: depends where in the state.
  assert.equal(zoneVerdict(ZONES.radiusSilverSpring, result(PLACES.maryland)), "partial");
});

test("a drawn outline covers what's inside it", () => {
  assert.equal(zoneVerdict(ZONES.northernVirginia, result(PLACES.arlingtonVa)), "covered");
  assert.equal(zoneVerdict(ZONES.northernVirginia, result(PLACES.richmondVa)), "outside");
  assert.equal(zoneVerdict(ZONES.northernVirginia, result(PLACES.baltimore)), "outside");
});

// --- the full check -------------------------------------------------------------

test("covered returns the contract, with the matched zone and the place as resolved", async () => {
  const response = await check([ZONES.montgomeryCounty], [PLACES.silverSpringMd]);
  assert.equal(response.status, "covered");
  assert.equal(response.ok, true);
  assert.equal(response.matched, true);
  assert.equal(response.matchedBy, "region");
  assert.equal(response.matchedArea, "Montgomery County, MD");
  assert.equal(response.confidence, "exact");
  assert.equal(response.message, COVERED_MESSAGE);
  assert.equal(response.clarificationQuestion, "");
  assert.deepEqual(response.canonicalLocation, {
    label: "Silver Spring, MD, United States",
    place: "Silver Spring",
    locality: "Silver Spring",
    county: "Montgomery",
    region: "Maryland",
    regionCode: "MD",
    country: "United States",
    countryCode: "USA",
    postalCode: null,
  });
});

test("matchedBy names the kind of zone", async () => {
  assert.equal((await check([ZONES.zip20910], [PLACES.zip20910plus4])).matchedBy, "postal_code");
  assert.equal((await check([ZONES.silverSpring], [PLACES.zip20910])).matchedBy, "place");
  assert.equal((await check([ZONES.radiusSilverSpring], [PLACES.zip20910])).matchedBy, "radius");
  assert.equal((await check([ZONES.northernVirginia], [PLACES.arlingtonVa])).matchedBy, "polygon");
});

test("outside gets the outside message, never a refusal without an offer", async () => {
  const response = await check([ZONES.maryland], [PLACES.richmondVa]);
  assert.equal(response.status, "outside");
  assert.equal(response.matched, false);
  assert.equal(response.message, OUTSIDE_MESSAGE);
  assert.equal(response.matchedBy, null);
});

test("same-named places: the one where the business works wins; a real tie asks", async () => {
  // Silver Spring, MD is covered; Silver Spring Twp, PA is nowhere near.
  const md = await check([ZONES.maryland], [PLACES.silverSpringMd, PLACES.silverSpringPa]);
  assert.equal(md.status, "covered");
  assert.equal(md.confidence, "contextual");
  // Arlington, VA is covered; Arlington, TX is where the business is.
  const tie = await check([ZONES.northernVirginia], [PLACES.arlingtonTx, PLACES.arlingtonVa], {
    contextRegions: new Set(["USA|TX", "USA|VA"]),
    usOnly: true,
  });
  assert.equal(tie.status, "ambiguous");
  assert.equal(tie.clarificationQuestion, "Which state is that in, or what's the ZIP code?");
  assert.deepEqual(tie.candidates.sort(), ["Arlington, TX, United States", "Arlington, VA, United States"]);
  // Outside the US the question says province and postal code.
  const abroad = await check([ZONES.northernVirginia], [PLACES.arlingtonTx, PLACES.arlingtonVa], { contextRegions: new Set(["USA|TX"]) });
  assert.equal(abroad.clarificationQuestion, "Which state or province is that in, or what's the postal code?");
});

test("several readings near the business that are all outside are simply outside", async () => {
  const richmondCounty = { ...PLACES.richmondVa, PlaceId: "richmond-county", PlaceType: "SubRegion", Title: "Richmond (County), VA, United States" };
  const response = await check([ZONES.maryland], [PLACES.richmondVa, richmondCounty], { contextRegions: new Set(["USA|VA", "USA|MD"]) });
  assert.equal(response.status, "outside");
  assert.equal(response.clarificationQuestion, "");
});

test("a place bigger than the zone asks for something narrower", async () => {
  const state = await check([ZONES.silverSpring], [PLACES.maryland], { usOnly: true });
  assert.equal(state.status, "ambiguous");
  assert.equal(state.clarificationQuestion, "Which city or town in Maryland is that, or what's the ZIP code?");
  const town = await check([ZONES.zip20910], [PLACES.silverSpringMd]);
  assert.equal(town.status, "ambiguous");
  assert.equal(town.clarificationQuestion, "What's the postal code there?");
});

test("an unknown or mangled place is unresolved - never covered by a guess", async () => {
  const nearMiss = await check([ZONES.maryland], [PLACES.bloomvilleNy]);
  assert.equal(nearMiss.status, "unresolved");
  assert.equal(nearMiss.matched, false);
  assert.equal(nearMiss.clarificationQuestion, "Sorry, did you say Bloomville, New York?");
  const nothing = await check([ZONES.maryland], [], { usOnly: true });
  assert.equal(nothing.clarificationQuestion, "Could you spell the name of the town for me, or give me the ZIP code?");
  // A business that happens to share the words is not a place.
  const business = await check([ZONES.northernVirginia], [PLACES.northernConcrete]);
  assert.equal(business.status, "unresolved");
});

test("a configured entry that couldn't be placed on the map still matches the same words", async () => {
  const response = await checkCoverage({
    location: "I'm on Capitol Hill",
    zones: [],
    legacyText: ["Capitol Hill"],
    geocode: async () => { throw new Error("not called"); },
  });
  assert.equal(response.status, "covered");
  assert.equal(response.matchedArea, "Capitol Hill");
});
