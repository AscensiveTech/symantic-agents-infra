import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_REGIONS, createRegionRegistry } from "./regions.mjs";
import {
  basicNorm,
  checkServiceArea,
  createResolver,
  datasetInfo,
  describeServiceAreas,
  loadGeography,
  nameKey,
  regionKey,
} from "./resolver.mjs";
import { CENSUS_DIVISIONS, CENSUS_REGIONS, STATES } from "./states.mjs";

const check = (location, serviceAreas, businessAddress = "") => checkServiceArea({ location, serviceAreas, businessAddress });

test("the dataset file matches its manifest and has every state, county and metro area", () => {
  const manifest = JSON.parse(readFileSync(new URL("./data/manifest.json", import.meta.url), "utf8"));
  const data = readFileSync(new URL(`./data/${manifest.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(data).digest("hex"), manifest.sha256);
  assert.deepEqual(datasetInfo().datasetVersion, manifest.datasetVersion);

  const geo = loadGeography();
  assert.equal(geo.counties.size, manifest.counts.counties);
  assert.equal(geo.cbsas.size, manifest.counts.cbsas);
  assert.equal(geo.zips.size, manifest.counts.zips);
  for (const state of STATES) assert.ok(geo.countiesByState.get(state.abbr)?.length, state.abbr);
  assert.ok(geo.cbsas.get("47900").counties.has("24031"), "Montgomery County, MD is in the Washington metro");
});

test("Census regions and divisions cover all 51 state-equivalents exactly once", () => {
  for (const groups of [CENSUS_REGIONS, CENSUS_DIVISIONS]) {
    const all = Object.values(groups).flat();
    assert.equal(all.length, 51);
    assert.equal(new Set(all).size, 51);
  }
});

test("normalization: punctuation, D.C., Saint/St., accents", () => {
  assert.equal(basicNorm("Washington, D.C."), "washington dc");
  assert.equal(basicNorm("  Prince George's   County "), "prince georges county");
  assert.equal(nameKey("St. Louis"), nameKey("Saint Louis"));
  assert.equal(nameKey("Mt. Airy"), nameKey("Mount Airy"));
  assert.equal(nameKey("Española"), "espanola");
});

test("region keys fold North/Northern, Mid West/Midwest, and the common nicknames", () => {
  assert.equal(regionKey("North Virginia"), regionKey("Northern Virginia"));
  assert.equal(regionKey("N. Virginia"), regionKey("Northern Virginia"));
  assert.equal(regionKey("South California"), regionKey("Southern California"));
  assert.equal(regionKey("Mid West"), regionKey("Midwest"));
  assert.equal(regionKey("North East"), regionKey("Northeast"));
  assert.equal(regionKey("Middle Atlantic"), regionKey("Mid-Atlantic"));
  assert.equal(regionKey("So Cal"), regionKey("SoCal"));
  assert.notEqual(regionKey("West Virginia"), regionKey("Virginia"));
});

test("every alias and abbreviation of a region resolves to the same place", () => {
  const cases = [
    ["Arlington, VA", ["Northern Virginia", "North Virginia", "NoVA", "Northern Virginia area"]],
    ["Los Angeles, CA", ["Southern California", "South California", "SoCal", "So Cal"]],
    ["Sacramento, CA", ["Northern California", "North California", "NorCal"]],
    ["Columbus, OH", ["Midwest", "Mid West", "the Midwest", "Midwest region"]],
    ["Hartford, CT", ["Northeast", "North East", "New England"]],
    ["Richmond, VA", ["Mid Atlantic", "Mid-Atlantic", "Middle Atlantic", "East Coast", "South"]],
    ["Bethesda, MD", ["DMV", "Washington DC metro", "DC metro area", "Washington-Arlington-Alexandria metro"]],
  ];
  for (const [location, regions] of cases) {
    for (const region of regions) assert.equal(check(location, [region]).status, "covered", `${location} in ${region}`);
  }
  assert.equal(check("Philadelphia, PA", ["Middle Atlantic division"]).status, "covered");
  assert.equal(check("Baltimore, MD", ["Middle Atlantic division"]).status, "outside");
});

test("Northern and Southern California split the state with no overlap", () => {
  const geo = loadGeography();
  const regions = new Map(DEFAULT_REGIONS.map((region) => [region.id, region]));
  const south = new Set(regions.get("southern-california").counties);
  const north = geo.countiesByState.get("CA").filter((county) => !regions.get("northern-california").excludeCounties.includes(county));
  assert.equal(south.size + north.length, geo.countiesByState.get("CA").length);
  assert.ok(north.every((county) => !south.has(county)));
});

test("formal metro areas resolve by their principal cities, with the state when given", () => {
  assert.equal(check("Plano, TX", ["Dallas-Fort Worth metroplex"]).status, "covered");
  assert.equal(check("Mount Pleasant, SC", ["Charleston, SC metro"]).status, "covered");
  assert.equal(check("Mount Pleasant, SC", ["Charleston area"], "1 King St, Charleston, SC 29401").status, "covered");
  assert.equal(check("Brooklyn", ["New York City metro area"]).status, "covered");
  // Connecticut's planning regions are its county equivalents.
  assert.equal(check("Hartford, CT", ["Capitol Planning Region"]).status, "covered");
  assert.equal(check("Stamford, CT", ["Capitol Planning Region"]).status, "outside");
});

test("a state named alone against a partial area asks which town", () => {
  const result = check("Maryland", ["Washington DC metro area"]);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.clarificationQuestion, "Which city or town in Maryland is that, or what's the ZIP code?");
  assert.equal(check("Maryland", ["Mid-Atlantic"]).status, "covered");
  assert.equal(check("Ohio", ["Mid-Atlantic"]).status, "outside");
});

test("a town the dataset doesn't know, in a state that's fully in or fully out, needs no town to decide", () => {
  assert.equal(check("Blorpville, MD", ["Maryland"]).status, "covered");
  assert.equal(check("Blorpville, MD", ["Maryland"]).confidence, "contextual");
  assert.equal(check("Blorpville, Ohio", ["Maryland"]).status, "outside");
  assert.equal(check("Blorpville, MD", ["Montgomery County, MD"]).status, "unresolved");
});

test("ZIP codes are matched on the five-digit base and the last ZIP in an address wins", () => {
  assert.equal(check("20910-1234", ["Montgomery County, MD"]).canonicalLocation.zip, "20910");
  assert.equal(check("209101234", ["Montgomery County, MD"]).status, "covered");
  assert.equal(check("10901 Rhode Island Ave, Beltsville, MD 20705", ["Prince George's County, MD"]).canonicalLocation.zip, "20705");
  assert.equal(check("99999", ["Maryland"]).status, "unresolved");
});

test("overrides extend or replace a region's membership without touching the defaults", () => {
  const withStafford = createResolver({
    regionOverrides: [{ id: "northern-virginia", counties: [...DEFAULT_REGIONS.find((region) => region.id === "northern-virginia").counties, "51179"] }],
  });
  assert.equal(withStafford.check({ location: "Stafford, VA", serviceAreas: ["Northern Virginia"] }).status, "covered");
  assert.equal(check("Stafford, VA", ["Northern Virginia"]).status, "outside");

  const custom = createResolver({ regionOverrides: [{ id: "eastern-shore", label: "Eastern Shore", aliases: ["Eastern Shore"], counties: ["24041"] }] });
  assert.equal(custom.check({ location: "Easton, MD", serviceAreas: ["Eastern Shore"] }).status, "covered");

  const merged = createRegionRegistry([{ id: "dmv", aliases: ["Capital Region"] }]).find((region) => region.id === "dmv");
  assert.ok(merged.aliases.includes("DMV") && merged.aliases.includes("Capital Region"));
});

test("an override cannot quietly claim another region's alias", () => {
  assert.throws(
    () => createResolver({ regionOverrides: [{ id: "my-region", aliases: ["NoVA"], states: ["VA"] }] }),
    /claimed by both/,
  );
});

test("the preview says what each entry was understood to include", () => {
  const preview = describeServiceAreas({
    serviceAreas: ["Washington D.C. Metro area", "Northern Virginia", "Charleston", "Capitol Hill", "20910"],
    businessAddress: "10901 Rhode Island Ave, Beltsville, MD 20705",
  });
  const byEntry = new Map(preview.map((item) => [item.entry, item]));
  assert.equal(byEntry.get("Washington D.C. Metro area").kind, "metro");
  assert.ok(byEntry.get("Washington D.C. Metro area").counties.includes("Montgomery County, MD"));
  assert.equal(byEntry.get("Northern Virginia").counties.length, 9);
  assert.equal(byEntry.get("Capitol Hill").kind, "unrecognized");
  assert.deepEqual(byEntry.get("20910").zips, ["20910"]);
  // Charleston with only Maryland context is still ambiguous - flagged, not guessed.
  assert.equal(byEntry.get("Charleston").ambiguous, true);
  assert.equal(byEntry.get(null).kind, "business_location");
});
