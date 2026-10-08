import assert from "node:assert/strict";
import test from "node:test";

import { OUTSIDE_MESSAGE } from "../geo/resolver.mjs";
import { handleServiceArea } from "./service-area.mjs";

function input(overrides = {}) {
  return {
    location: "Arlington, VA",
    serviceAreas: JSON.stringify(["Arlington, VA", "Alexandria, VA", "22201"]),
    ...overrides,
  };
}

const check = (location, serviceAreas, businessAddress) =>
  handleServiceArea({ location, serviceAreas: JSON.stringify(serviceAreas), ...(businessAddress ? { businessAddress } : {}) });

// --- existing exact matching keeps working -----------------------------------

test("exact city match", async () => {
  const result = await handleServiceArea(input({ location: "Alexandria, VA" }));
  assert.equal(result.matched, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "covered");
  assert.equal(result.matchedBy, "place");
  assert.equal(result.confidence, "exact");
  assert.equal(result.matchedArea, "Alexandria, VA");
});

test("case and whitespace insensitive", async () => {
  const result = await handleServiceArea(input({ location: "  ARLINGTON,   va " }));
  assert.equal(result.matched, true);
});

test("caller phrasing with extra words around a listed city still matches (whole-word)", async () => {
  const result = await handleServiceArea(input({ location: "I'm calling from near Arlington today" }));
  assert.equal(result.matched, true);
  assert.equal(result.canonicalLocation.state, "VA");
});

test("a listed city that's a substring of another word does not false-positive", async () => {
  // "Arlington" must not match inside an unrelated longer word.
  const result = await handleServiceArea(input({ location: "Darlingtonville" }));
  assert.equal(result.matched, false);
  assert.equal(result.status, "unresolved");
});

test("ZIP exact match", async () => {
  const result = await handleServiceArea(input({ location: "22201" }));
  assert.equal(result.matched, true);
  assert.equal(result.matchedBy, "zip");
  assert.equal(result.canonicalLocation.zip, "22201");
});

test("ZIP+4 on the configured side still matches the caller's plain 5-digit ZIP", async () => {
  const result = await handleServiceArea(input({ location: "22201", serviceAreas: JSON.stringify(["22201-1234"]) }));
  assert.equal(result.matched, true);
});

test("ZIP+4 spoken by the caller matches its five-digit base", async () => {
  const result = await handleServiceArea(input({ location: "22201-1234", serviceAreas: JSON.stringify(["22201"]) }));
  assert.equal(result.matched, true);
  assert.equal(result.matchedBy, "zip");
  assert.equal(result.canonicalLocation.zip, "22201");
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

test("the business's own town and ZIP are always covered", async () => {
  const businessAddress = "10901 Rhode Island Ave, Beltsville, MD 20705";
  const serviceAreas = ["Charleston, SC"];
  const town = await check("Beltsville", serviceAreas, businessAddress);
  assert.equal(town.status, "covered");
  assert.equal(town.matchedBy, "business_location");
  assert.equal((await check("20705", serviceAreas, businessAddress)).matchedBy, "business_location");
  // The street number is not mistaken for the ZIP.
  assert.equal((await check("10901", serviceAreas, businessAddress)).matched, false);
  // Agents published before businessAddress existed still work.
  assert.equal((await check("Beltsville", serviceAreas)).matched, false);
});

// --- states ------------------------------------------------------------------

test("a state entry covers places given with that state's name or abbreviation", async () => {
  const serviceAreas = ["Maryland", "Northern Virginia", "Washington DC"];
  for (const location of ["Beltsville, MD", "Beltsville, Maryland", "Beltsville MD 20705"]) {
    assert.equal((await check(location, serviceAreas)).matched, true, location);
  }
});

test("a configured whole state covers an unlisted town in it", async () => {
  const result = await check("Hagerstown", ["Maryland"]);
  assert.equal(result.status, "covered");
  assert.equal(result.matchedBy, "state");
  assert.equal(result.canonicalLocation.state, "MD");
});

test("Virginia does not match West Virginia, Washington DC is not Washington state, and 'in' is not Indiana", async () => {
  const wv = await check("Morgantown, West Virginia", ["Virginia"]);
  assert.equal(wv.status, "outside");
  assert.equal(wv.canonicalLocation.state, "WV");
  const wa = await check("Seattle, Washington", ["Washington DC"]);
  assert.equal(wa.status, "outside");
  assert.equal(wa.canonicalLocation.state, "WA");
  const dc = await check("Washington, D.C.", ["Washington State"]);
  assert.equal(dc.status, "outside");
  assert.equal(dc.canonicalLocation.state, "DC");
  assert.equal((await check("calling in from Ohio", ["IN"])).matched, false);
  assert.equal((await check("Muncie IN", ["Indiana"])).matched, true);
});

// --- Silver Spring --------------------------------------------------------------

test("Silver Spring is covered by the Washington DC metro area", async () => {
  const result = await check("Silver Spring", ["Washington DC metro area"]);
  assert.equal(result.status, "covered");
  assert.equal(result.matchedBy, "metro");
  assert.equal(result.matchedArea, "Washington DC metro area");
  assert.equal(result.confidence, "contextual");
  assert.deepEqual(result.canonicalLocation, {
    place: "Silver Spring",
    state: "MD",
    zip: null,
    county: "Montgomery County",
    metro: "Washington-Arlington-Alexandria, DC-VA-MD-WV",
  });
});

test("Silver Spring is covered by Maryland; 'Silver Spring, MD', 'Silver Spring Maryland' and 20910 resolve to the same place", async () => {
  assert.equal((await check("Silver Spring", ["Maryland"])).status, "covered");
  const exact = await check("Silver Spring, MD", ["MD"]);
  assert.equal(exact.status, "covered");
  assert.equal(exact.confidence, "exact");
  for (const location of ["Silver Spring, MD", "Silver Spring Maryland", "20910"]) {
    const result = await check(location, ["Washington D.C. Metro area"]);
    assert.equal(result.status, "covered", location);
    assert.equal(result.canonicalLocation.place, "Silver Spring", location);
    assert.equal(result.canonicalLocation.state, "MD", location);
    assert.equal(result.canonicalLocation.county, "Montgomery County", location);
  }
});

test("a metro area covers an unlisted suburb in a member county", async () => {
  // Leesburg is in Loudoun County, part of the Washington metro area.
  const result = await check("Leesburg, VA", ["DC metro area"]);
  assert.equal(result.status, "covered");
  assert.equal(result.matchedBy, "metro");
  assert.equal(result.canonicalLocation.county, "Loudoun County");
});

// --- named regions ------------------------------------------------------------------

test("Arlington, VA is in Northern Virginia, and a state-less Alexandria is too when context makes it unambiguous", async () => {
  const arlington = await check("Arlington, VA", ["Northern Virginia"]);
  assert.equal(arlington.status, "covered");
  assert.equal(arlington.matchedBy, "region");
  const alexandria = await check("Alexandria", ["NoVA"]);
  assert.equal(alexandria.status, "covered");
  assert.equal(alexandria.confidence, "contextual");
  assert.equal(alexandria.canonicalLocation.state, "VA");
  assert.equal((await check("Fairfax", ["North Virginia"])).status, "covered");
});

test("San Diego is in Southern California and San Francisco in Northern California (documented defaults)", async () => {
  assert.equal((await check("San Diego", ["Southern California"])).status, "covered");
  assert.equal((await check("San Diego", ["SoCal"])).status, "covered");
  assert.equal((await check("San Diego", ["Northern California"])).status, "outside");
  assert.equal((await check("San Francisco", ["Northern California"])).status, "covered");
  assert.equal((await check("San Francisco", ["NorCal"])).status, "covered");
  assert.equal((await check("San Francisco", ["South California"])).status, "outside");
});

test("an Ohio city is in the Midwest and a Pennsylvania city in the Northeast, however the region is spelled", async () => {
  for (const region of ["Midwest", "Mid West", "midwestern US"]) {
    assert.equal((await check("Columbus, Ohio", [region])).status, "covered", region);
  }
  for (const region of ["Northeast", "North East"]) {
    const result = await check("Scranton, PA", [region]);
    assert.equal(result.status, "covered", region);
    assert.equal(result.matchedBy, "region");
  }
});

test("Mid-Atlantic, East Coast and West Coast follow the registry", async () => {
  for (const region of ["Mid Atlantic", "Mid-Atlantic", "Middle Atlantic"]) {
    assert.equal((await check("Baltimore, MD", [region])).status, "covered", region);
  }
  assert.equal((await check("Savannah, GA", ["East Coast"])).status, "covered");
  assert.equal((await check("Portland, OR", ["West Coast"])).status, "covered");
  assert.equal((await check("Denver, CO", ["West Coast"])).status, "outside");
});

// --- ambiguity, unresolved, outside -------------------------------------------------

test("a genuinely ambiguous state-less city asks for the state or ZIP", async () => {
  // Arlington, VA is covered; Arlington, TX is where the business is.
  const result = await check("Arlington", ["Northern Virginia"], "100 Main St, Dallas, TX 75201");
  assert.equal(result.status, "ambiguous");
  assert.equal(result.matched, false);
  assert.equal(result.confidence, "ambiguous");
  assert.equal(result.clarificationQuestion, "Which state is that in, or what's the ZIP code?");
  assert.equal(result.matchedBy, null);
});

test("a place only partly inside the area asks for the ZIP", async () => {
  const result = await check("Kansas City, MO", ["Jackson County, MO"]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.clarificationQuestion, "What's the ZIP code there?");
});

test("an unknown or mangled place is unresolved - never covered by guessing", async () => {
  for (const location of ["Blorpville", "Flibbertown", "the place by the lake"]) {
    const result = await check(location, ["Maryland", "Washington DC metro area"]);
    assert.equal(result.status, "unresolved", location);
    assert.equal(result.matched, false, location);
    assert.equal(result.matchedBy, null, location);
    assert.ok(result.clarificationQuestion, location);
  }
});

test("a likely mishearing of a nearby place offers the real place instead of an answer", async () => {
  const plural = await check("Silver Springs", ["Maryland"]);
  assert.equal(plural.status, "ambiguous");
  assert.equal(plural.suggestion, "Silver Spring, MD");
  assert.match(plural.clarificationQuestion, /^Did you mean Silver Spring, Maryland\?/);
  const typo = await check("Gaithersberg", ["Montgomery County, MD"]);
  assert.equal(typo.status, "unresolved");
  assert.equal(typo.clarificationQuestion, "Sorry, did you say Gaithersburg?");
});

test("an outside location gets the team-confirmation line, never a refusal", async () => {
  const result = await check("Seattle, WA", ["Arlington, VA", "Alexandria, VA", "22201"]);
  assert.equal(result.status, "outside");
  assert.equal(result.matched, false);
  assert.equal(result.message, OUTSIDE_MESSAGE);
  assert.equal(result.message, "Our team confirms coverage for addresses out that way. I can take your details and have them follow up.");
  assert.equal(result.clarificationQuestion, "");
});

test("the screenshot configuration: comma-split entries, Charleston resolved to South Carolina", async () => {
  const serviceAreas = ["Washington D.C. Metro area", "Maryland", "Northern Virginia", "Washington DC", "Charleston",
    "South Carolina and surrounding areas"];
  const businessAddress = "10901 Rhode Island Ave, Beltsville, MD 20705";
  for (const location of ["Silver Spring", "Rockville", "Arlington", "Georgetown, DC", "Mount Pleasant, SC", "Charleston"]) {
    assert.equal((await check(location, serviceAreas, businessAddress)).status, "covered", location);
  }
  assert.equal((await check("Charleston, West Virginia", serviceAreas, businessAddress)).status, "outside");
  assert.equal((await check("Richmond, VA", serviceAreas, businessAddress)).status, "outside");
});

test("one 'City, State and surrounding areas' entry (the wizard's new comma handling) covers that metro area", async () => {
  const serviceAreas = ["Charleston, South Carolina and surrounding areas"];
  const suburb = await check("Summerville, SC", serviceAreas);
  assert.equal(suburb.status, "covered");
  assert.equal(suburb.matchedBy, "metro");
  assert.equal((await check("Columbia, SC", serviceAreas)).status, "outside");
});

test("a configured entry the dataset doesn't know still matches the same words", async () => {
  const result = await check("Capitol Hill", ["Capitol Hill"]);
  assert.equal(result.status, "covered");
  assert.equal(result.matchedArea, "Capitol Hill");
});
