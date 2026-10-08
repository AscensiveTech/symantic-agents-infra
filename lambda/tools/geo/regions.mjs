// Named regions a business can list as a service area, and a caller can
// name as their location. Kept here, versioned, rather than in the prompt:
// the model never decides what "Northern Virginia" contains.
//
// Two kinds:
// - Formal: Census regions and divisions (generated from states.mjs). Their
//   membership is official and not up for debate.
// - Informal: everyday business terms whose boundaries vary by who you ask.
//   Each one records the default definition chosen and why. These defaults
//   need product sign-off (docs/service-area-geography.md) and can be
//   overridden or extended with createRegionRegistry(overrides).
//
// Membership is any of: whole `states`, extra `counties` (5-digit FIPS),
// `excludeCounties` carved out of those states, or a `cbsa` / `csa` code
// from the OMB delineation in the dataset. Aliases are matched after
// normalization (see regionKey in resolver.mjs), so "North Virginia",
// "northern virginia" and "N. Virginia" need no separate entries beyond the
// canonical spelling - "North"/"Northern" and "Mid West"/"Midwest" are
// folded together automatically.

import { CENSUS_DIVISIONS, CENSUS_REGIONS } from "./states.mjs";

export const REGION_REGISTRY_VERSION = "2026-10-08.1";

const SOUTHERN_CALIFORNIA_COUNTIES = [
  "06025", // Imperial
  "06029", // Kern
  "06037", // Los Angeles
  "06059", // Orange
  "06065", // Riverside
  "06071", // San Bernardino
  "06073", // San Diego
  "06079", // San Luis Obispo
  "06083", // Santa Barbara
  "06111", // Ventura
];

const INFORMAL_REGIONS = [
  {
    id: "northern-virginia",
    label: "Northern Virginia",
    aliases: ["Northern Virginia", "NoVA", "No VA", "N Virginia"],
    counties: [
      "51013", // Arlington County
      "51059", // Fairfax County
      "51107", // Loudoun County
      "51153", // Prince William County
      "51510", // Alexandria city
      "51600", // Fairfax city
      "51610", // Falls Church city
      "51683", // Manassas city
      "51685", // Manassas Park city
    ],
    definition: "The Northern Virginia Regional Commission's member jurisdictions. Stafford and Fauquier "
      + "counties are sometimes included informally but are not by default.",
  },
  {
    id: "dmv",
    label: "DMV (DC, Maryland, Virginia)",
    aliases: ["DMV", "the DMV", "DMV area"],
    cbsa: "47900",
    definition: "The Washington-Arlington-Alexandria, DC-VA-MD-WV metropolitan area, which is what businesses "
      + "usually mean by the DMV - not all of Maryland and Virginia.",
  },
  {
    id: "southern-maryland",
    label: "Southern Maryland",
    aliases: ["Southern Maryland", "SoMD", "So MD"],
    counties: ["24009", "24017", "24037"], // Calvert, Charles, St. Mary's
    definition: "Calvert, Charles and St. Mary's counties (the Tri-County Council for Southern Maryland).",
  },
  {
    id: "southern-california",
    label: "Southern California",
    aliases: ["Southern California", "SoCal", "So Cal", "S California"],
    counties: SOUTHERN_CALIFORNIA_COUNTIES,
    definition: "The ten southernmost counties: Imperial, Kern, Los Angeles, Orange, Riverside, San Bernardino, "
      + "San Diego, San Luis Obispo, Santa Barbara and Ventura.",
  },
  {
    id: "northern-california",
    label: "Northern California",
    aliases: ["Northern California", "NorCal", "Nor Cal", "N California"],
    states: ["CA"],
    excludeCounties: SOUTHERN_CALIFORNIA_COUNTIES,
    definition: "Every California county not in Southern California (the other 48), so the two never overlap "
      + "and together cover the whole state. Narrower uses that exclude the Central Valley are not the default.",
  },
  {
    id: "bay-area",
    label: "San Francisco Bay Area",
    aliases: ["Bay Area", "SF Bay Area", "San Francisco Bay Area"],
    counties: ["06001", "06013", "06041", "06055", "06075", "06081", "06085", "06095", "06097"],
    definition: "The nine counties of the Association of Bay Area Governments: Alameda, Contra Costa, Marin, "
      + "Napa, San Francisco, San Mateo, Santa Clara, Solano and Sonoma.",
  },
  {
    id: "inland-empire",
    label: "Inland Empire",
    aliases: ["Inland Empire"],
    cbsa: "40140",
    definition: "The Riverside-San Bernardino-Ontario, CA metropolitan area (Riverside and San Bernardino counties).",
  },
  {
    id: "mid-atlantic",
    label: "Mid-Atlantic",
    aliases: ["Mid-Atlantic", "Mid Atlantic", "Middle Atlantic", "Mid-Atlantic states"],
    states: ["NY", "NJ", "PA", "DE", "MD", "DC", "VA", "WV"],
    definition: "New York, New Jersey, Pennsylvania, Delaware, Maryland, DC, Virginia and West Virginia - the "
      + "common business meaning. The narrower Census Middle Atlantic division (NY, NJ, PA) is available as "
      + "\"Middle Atlantic division\".",
  },
  {
    id: "east-coast",
    label: "East Coast",
    aliases: ["East Coast", "Eastern Seaboard", "Atlantic Coast", "Eastern US"],
    states: ["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "PA", "DE", "MD", "DC", "VA", "NC", "SC", "GA", "FL"],
    definition: "The 14 states on the Atlantic coast plus DC and Pennsylvania.",
  },
  {
    id: "west-coast",
    label: "West Coast",
    aliases: ["West Coast", "Pacific Coast"],
    states: ["CA", "OR", "WA"],
    definition: "California, Oregon and Washington. Alaska and Hawaii are not included by default.",
  },
  {
    id: "pacific-northwest",
    label: "Pacific Northwest",
    aliases: ["Pacific Northwest", "PNW"],
    states: ["WA", "OR", "ID"],
    definition: "Washington, Oregon and Idaho.",
  },
  {
    id: "southeast",
    label: "Southeast",
    aliases: ["Southeast", "Southeastern US", "the Southeast"],
    states: ["AL", "FL", "GA", "MS", "NC", "SC", "TN"],
    definition: "Alabama, Florida, Georgia, Mississippi, North Carolina, South Carolina and Tennessee.",
  },
  {
    id: "southwest",
    label: "Southwest",
    aliases: ["Southwest", "Southwestern US", "the Southwest"],
    states: ["AZ", "NM", "TX", "OK"],
    definition: "Arizona, New Mexico, Texas and Oklahoma.",
  },
  {
    id: "hampton-roads",
    label: "Hampton Roads",
    aliases: ["Hampton Roads", "Tidewater"],
    cbsa: "47260",
    definition: "The Virginia Beach-Chesapeake-Norfolk, VA-NC metropolitan area.",
  },
  {
    id: "twin-cities",
    label: "Twin Cities",
    aliases: ["Twin Cities"],
    cbsa: "33460",
    definition: "The Minneapolis-St. Paul-Bloomington, MN-WI metropolitan area.",
  },
  {
    id: "south-florida",
    label: "South Florida",
    aliases: ["South Florida", "SoFlo"],
    cbsa: "33100",
    definition: "The Miami-Fort Lauderdale-West Palm Beach, FL metropolitan area (Miami-Dade, Broward, Palm Beach).",
  },
  {
    id: "research-triangle",
    label: "Research Triangle",
    aliases: ["Research Triangle", "the Triangle", "Triangle area"],
    csa: "450",
    definition: "The Raleigh-Durham-Cary, NC combined statistical area.",
  },
].map((region) => ({ ...region, kind: "informal" }));

const FORMAL_REGIONS = [
  ...Object.entries(CENSUS_REGIONS).map(([label, states]) => ({
    id: `census-region-${label.toLowerCase()}`,
    label,
    kind: "census-region",
    aliases: [label, `${label} region`, `${label}ern US`, `the ${label}`, `${label}ern states`],
    states,
    definition: `Census Bureau ${label} region.`,
  })),
  ...Object.entries(CENSUS_DIVISIONS).map(([label, states]) => ({
    id: `census-division-${label.toLowerCase().replace(/ /g, "-")}`,
    label: `${label} division`,
    kind: "census-division",
    // "Middle Atlantic" (with or without "states") means the informal
    // Mid-Atlantic above; "Mountain" / "Pacific" alone are too vague, so
    // divisions need "division" or "states" - except New England, which is
    // unambiguous.
    aliases: [
      `${label} division`,
      ...(label === "Middle Atlantic" ? [] : [`${label} states`]),
      ...(label === "New England" ? [label] : []),
    ],
    states,
    definition: `Census Bureau ${label} division.`,
  })),
];

export const DEFAULT_REGIONS = Object.freeze([...FORMAL_REGIONS, ...INFORMAL_REGIONS]);

// Merge overrides into the defaults by id: a matching id replaces the given
// fields (aliases are added, not replaced); a new id adds a region. This is
// the hook for a per-business or per-release change of a definition without
// editing the defaults.
export function createRegionRegistry(overrides = []) {
  const byId = new Map(DEFAULT_REGIONS.map((region) => [region.id, region]));
  for (const override of overrides) {
    if (!override?.id) continue;
    const base = byId.get(override.id);
    byId.set(override.id, base
      ? { ...base, ...override, aliases: [...new Set([...base.aliases, ...(override.aliases ?? [])])] }
      : { kind: "informal", aliases: [], ...override });
  }
  return [...byId.values()];
}
