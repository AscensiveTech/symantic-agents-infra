// The 50 states plus DC: USPS abbreviation, FIPS code, and the official
// Census Bureau region and division each belongs to. These are formal,
// stable definitions (Census Regions and Divisions of the United States),
// so they live in code rather than in the generated dataset. Territories
// (PR, GU, VI, ...) are deliberately out of scope.

const ROWS = [
  // abbr, fips, name, region, division
  ["AL", "01", "Alabama", "South", "East South Central"],
  ["AK", "02", "Alaska", "West", "Pacific"],
  ["AZ", "04", "Arizona", "West", "Mountain"],
  ["AR", "05", "Arkansas", "South", "West South Central"],
  ["CA", "06", "California", "West", "Pacific"],
  ["CO", "08", "Colorado", "West", "Mountain"],
  ["CT", "09", "Connecticut", "Northeast", "New England"],
  ["DE", "10", "Delaware", "South", "South Atlantic"],
  ["DC", "11", "District of Columbia", "South", "South Atlantic"],
  ["FL", "12", "Florida", "South", "South Atlantic"],
  ["GA", "13", "Georgia", "South", "South Atlantic"],
  ["HI", "15", "Hawaii", "West", "Pacific"],
  ["ID", "16", "Idaho", "West", "Mountain"],
  ["IL", "17", "Illinois", "Midwest", "East North Central"],
  ["IN", "18", "Indiana", "Midwest", "East North Central"],
  ["IA", "19", "Iowa", "Midwest", "West North Central"],
  ["KS", "20", "Kansas", "Midwest", "West North Central"],
  ["KY", "21", "Kentucky", "South", "East South Central"],
  ["LA", "22", "Louisiana", "South", "West South Central"],
  ["ME", "23", "Maine", "Northeast", "New England"],
  ["MD", "24", "Maryland", "South", "South Atlantic"],
  ["MA", "25", "Massachusetts", "Northeast", "New England"],
  ["MI", "26", "Michigan", "Midwest", "East North Central"],
  ["MN", "27", "Minnesota", "Midwest", "West North Central"],
  ["MS", "28", "Mississippi", "South", "East South Central"],
  ["MO", "29", "Missouri", "Midwest", "West North Central"],
  ["MT", "30", "Montana", "West", "Mountain"],
  ["NE", "31", "Nebraska", "Midwest", "West North Central"],
  ["NV", "32", "Nevada", "West", "Mountain"],
  ["NH", "33", "New Hampshire", "Northeast", "New England"],
  ["NJ", "34", "New Jersey", "Northeast", "Middle Atlantic"],
  ["NM", "35", "New Mexico", "West", "Mountain"],
  ["NY", "36", "New York", "Northeast", "Middle Atlantic"],
  ["NC", "37", "North Carolina", "South", "South Atlantic"],
  ["ND", "38", "North Dakota", "Midwest", "West North Central"],
  ["OH", "39", "Ohio", "Midwest", "East North Central"],
  ["OK", "40", "Oklahoma", "South", "West South Central"],
  ["OR", "41", "Oregon", "West", "Pacific"],
  ["PA", "42", "Pennsylvania", "Northeast", "Middle Atlantic"],
  ["RI", "44", "Rhode Island", "Northeast", "New England"],
  ["SC", "45", "South Carolina", "South", "South Atlantic"],
  ["SD", "46", "South Dakota", "Midwest", "West North Central"],
  ["TN", "47", "Tennessee", "South", "East South Central"],
  ["TX", "48", "Texas", "South", "West South Central"],
  ["UT", "49", "Utah", "West", "Mountain"],
  ["VT", "50", "Vermont", "Northeast", "New England"],
  ["VA", "51", "Virginia", "South", "South Atlantic"],
  ["WA", "53", "Washington", "West", "Pacific"],
  ["WV", "54", "West Virginia", "South", "South Atlantic"],
  ["WI", "55", "Wisconsin", "Midwest", "East North Central"],
  ["WY", "56", "Wyoming", "West", "Mountain"],
];

export const STATES = Object.freeze(ROWS.map(([abbr, fips, name, region, division]) =>
  Object.freeze({ abbr, fips, name, region, division })));

export const STATE_BY_ABBR = new Map(STATES.map((state) => [state.abbr, state]));
export const STATE_BY_FIPS = new Map(STATES.map((state) => [state.fips, state]));

// Census regions and divisions as { label, states }, keyed by their
// normalized names. Used by the region registry as formal regions.
export const CENSUS_REGIONS = Object.freeze(groupBy("region"));
export const CENSUS_DIVISIONS = Object.freeze(groupBy("division"));

function groupBy(field) {
  const groups = {};
  for (const state of STATES) {
    (groups[state[field]] ??= []).push(state.abbr);
  }
  return Object.fromEntries(Object.entries(groups).map(([label, states]) => [label, Object.freeze(states)]));
}
