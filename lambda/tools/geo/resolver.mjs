// Deterministic US service-area resolver. Given the business's configured
// service areas and a location a caller said, decides covered / outside /
// ambiguous / unresolved from a local, versioned Census dataset - never from
// the language model's memory, and with no network or database access.
//
// Layers, in order:
//   1. normalize the caller's words (case, punctuation, D.C., St./Saint,
//      North/Northern, ZIP+4, "metro area", ...)
//   2. look the place up locally: ZIP (Census ZCTA), place / town, county,
//      state, metro area (OMB CBSA/CSA), named region (regions.mjs)
//   3. use the business's own context (its address, the states it lists)
//      to pick between same-named places
//   4. if that still leaves more than one answer, return one short
//      clarification question
//   5. a name that isn't a real place is `unresolved` - it is never
//      matched against coverage by guesswork
//
// See docs/service-area-geography.md for sources, definitions and refresh.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { createRegionRegistry, REGION_REGISTRY_VERSION } from "./regions.mjs";
import { STATE_BY_ABBR, STATE_BY_FIPS, STATES } from "./states.mjs";

const DATA_FILE = new URL("./data/us-geo.txt.gz", import.meta.url);

// Say it's outside first, then offer - never the other way around.
export const OUTSIDE_MESSAGE = "We don't currently serve that area - it's outside our service area. If you'd like, I "
  + "can take your address and have the team review it.";
export const COVERED_MESSAGE = "That location is within our published service area.";
const ASK_STATE_OR_ZIP = "Which state is that in, or what's the ZIP code?";
const ASK_ZIP = "What's the ZIP code there?";
const ASK_SPELLING = "Could you spell the name of the town for me, or give me the ZIP code?";

// matchedBy precedence when several configured areas cover the same place.
const MATCH_RANK = { zip: 1, place: 2, business_location: 3, state: 4, county: 5, metro: 6, region: 7 };

// ---------------------------------------------------------------------------
// Dataset loading (lazy, once per Lambda container)
// ---------------------------------------------------------------------------

let defaultGeography;
let defaultRegistry;

export function loadGeography() {
  defaultGeography ??= indexGeography(gunzipSync(readFileSync(DATA_FILE)).toString("utf8"));
  return defaultGeography;
}

function defaultRegions(geo) {
  defaultRegistry ??= buildRegionIndex(geo, createRegionRegistry());
  return defaultRegistry;
}

export function indexGeography(text) {
  const geo = {
    version: null,
    counties: new Map(),
    countiesByKey: new Map(),
    countiesByState: new Map(),
    cbsas: new Map(),
    csas: new Map(),
    countyCbsa: new Map(),
    metrosByKey: new Map(),
    placesByKey: new Map(),
    placesByState: new Map(),
    zips: new Map(),
    zipsByPlace: new Map(),
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("#")) {
      geo.version = line.split(" ")[1] ?? null;
      continue;
    }
    const fields = line.split("|");
    if (fields[0] === "C") {
      const [, geoid, name] = fields;
      const county = { geoid, name, state: stateOfCounty(geoid) };
      geo.counties.set(geoid, county);
      push(geo.countiesByKey, nameKey(name), county);
      const bare = countyBaseKey(name);
      if (bare !== nameKey(name)) push(geo.countiesByKey, bare, county);
      push(geo.countiesByState, county.state, geoid);
    } else if (fields[0] === "S") {
      const [, code, title] = fields;
      geo.csas.set(code, { type: "csa", code, title, metropolitan: true, counties: new Set(), ...titleParts(title) });
    } else if (fields[0] === "B") {
      const [, code, kind, csa, title, countyList] = fields;
      const cbsa = { type: "cbsa", code, title, metropolitan: kind === "M", csa: csa || null, counties: new Set(countyList.split(" ")), ...titleParts(title) };
      geo.cbsas.set(code, cbsa);
      for (const county of cbsa.counties) {
        geo.countyCbsa.set(county, code);
        if (cbsa.csa) geo.csas.get(cbsa.csa)?.counties.add(county);
      }
    } else if (fields[0] === "P") {
      const [, stateFips, name, countyList, kind, aliasList] = fields;
      const state = STATE_BY_FIPS.get(stateFips).abbr;
      const place = {
        name,
        state,
        key: nameKey(name),
        town: kind === "t",
        counties: countyList ? countyList.split(" ").map((county) => stateFips + county) : [],
      };
      const keys = new Set([place.key, ...(aliasList ? aliasList.split(";").map(nameKey) : [])]);
      // "Boise City" is "Boise" to a caller; "Kansas City" is never "Kansas".
      const bareCity = place.key.match(/^(.+) city$/)?.[1];
      if (bareCity && !STATE_NAME_KEYS.has(bareCity)) keys.add(bareCity);
      for (const key of keys) push(geo.placesByKey, key, place);
      push(geo.placesByState, state, place);
    } else if (fields[0] === "Z") {
      const [, zip, countyList, placeName] = fields;
      const counties = countyList.split(" ");
      const row = { zip, counties, state: stateOfCounty(counties[0]), placeName: placeName || null };
      geo.zips.set(zip, row);
      if (row.placeName) push(geo.zipsByPlace, `${row.state}|${nameKey(row.placeName)}`, zip);
    }
  }
  for (const metro of [...geo.cbsas.values(), ...geo.csas.values()]) {
    // Every run of consecutive title cities is a lookup key: "Dallas-Fort
    // Worth-Arlington" answers to "Dallas", "Fort Worth", "Dallas Fort
    // Worth", ... and "Winston-Salem" to "Winston Salem".
    for (let start = 0; start < metro.cities.length; start += 1) {
      for (let end = start + 1; end <= metro.cities.length; end += 1) {
        push(geo.metrosByKey, metro.cities.slice(start, end).join(" "), { metro, start });
      }
    }
  }
  return geo;
}

function titleParts(title) {
  const [cityPart, statePart = ""] = title.split(/,\s*(?=[A-Z]{2}(?:-[A-Z]{2})*$)/);
  return {
    cities: cityPart.split(/[-/]/).map(nameKey).filter(Boolean),
    states: statePart.split("-").filter((abbr) => STATE_BY_ABBR.has(abbr)),
  };
}

function stateOfCounty(geoid) {
  return STATE_BY_FIPS.get(geoid.slice(0, 2))?.abbr ?? null;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Lowercase ASCII words: accents, apostrophes and punctuation dropped,
// "D.C." -> "dc", "&" -> "and".
export function basicNorm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bd c\b/g, "dc")
    .trim();
}

const NAME_ABBREVIATIONS = { st: "saint", ste: "sainte", ft: "fort", mt: "mount", mtn: "mountain", pt: "point" };

// Key for place / county names: also folds St./Saint, Ft./Fort, Mt./Mount.
export function nameKey(value) {
  return basicNorm(value).split(" ").map((token) => NAME_ABBREVIATIONS[token] ?? token).join(" ");
}

function countyBaseKey(name) {
  return nameKey(name).replace(/ (county|parish|borough|census area|city and borough|municipality|planning region|city)$/, "");
}

const STATE_NAME_KEYS = new Map(STATES.map((state) => [basicNorm(state.name), state.abbr]));
// Longest first, so "west virginia" is tried before "virginia".
const STATE_NAMES_LONGEST_FIRST = [...STATE_NAME_KEYS.keys()].sort((a, b) => b.length - a.length);
// Two-letter abbreviations that are also everyday English words: only a
// state when written in capitals, after a comma, or right after a place in
// that state ("Muncie IN") - never "calling in" or "it's me".
const WORD_ABBREVIATIONS = new Set(["in", "me", "or", "oh", "hi", "ok", "la", "de", "co", "al", "ma", "pa", "id", "mo", "ga", "wa", "ar", "mt", "ne"]);

const REGION_MERGES = [
  [/\bnorth east(ern)?\b/g, "northeast"], [/\bsouth east(ern)?\b/g, "southeast"],
  [/\bnorth west(ern)?\b/g, "northwest"], [/\bsouth west(ern)?\b/g, "southwest"],
  [/\b(mid|middle) west(ern)?\b/g, "midwest"], [/\b(mid|middle) atlantic\b|\bmidatlantic\b/g, "mid atlantic"],
  [/\b(northeast|southeast|northwest|southwest|midwest)ern\b/g, "$1"],
  [/\bso cal\b/g, "socal"], [/\bnor cal\b/g, "norcal"], [/\bno va\b/g, "nova"], [/\bso md\b/g, "somd"],
];
const DIRECTION_WORDS = { north: "northern", south: "southern", east: "eastern", west: "western" };
const DIRECTION_LETTERS = { n: "northern", s: "southern", e: "eastern", w: "western" };

// Key for region aliases: "North Virginia" = "Northern Virginia" = "N.
// Virginia", "Mid West" = "Midwest", "Middle Atlantic" = "Mid-Atlantic".
export function regionKey(value) {
  let key = basicNorm(value);
  for (const [pattern, replacement] of REGION_MERGES) key = key.replace(pattern, replacement);
  const tokens = key.split(" ").filter(Boolean);
  if (tokens[0] === "the") tokens.shift();
  return tokens
    .map((token, index) => DIRECTION_WORDS[token] ?? (index === 0 && tokens.length > 1 ? DIRECTION_LETTERS[token] : null) ?? token)
    .join(" ");
}

const REGION_SUFFIX = / (region|area|states|us|usa|united states|of the us|of the united states)$/;

function buildRegionIndex(geo, regions) {
  const byKey = new Map();
  for (const region of regions) {
    const resolved = resolveRegion(geo, region);
    for (const alias of region.aliases) {
      const key = regionKey(alias);
      const existing = byKey.get(key);
      if (existing && existing.id !== region.id) {
        throw new Error(`Region alias "${alias}" is claimed by both ${existing.id} and ${region.id}`);
      }
      byKey.set(key, resolved);
    }
  }
  return {
    version: REGION_REGISTRY_VERSION,
    regions: regions.map((region) => resolveRegion(geo, region)),
    lookup(phrase) {
      const key = regionKey(phrase);
      return byKey.get(key) ?? byKey.get(key.replace(REGION_SUFFIX, "")) ?? null;
    },
  };
}

function resolveRegion(geo, region) {
  const counties = new Set(region.counties ?? []);
  const metro = region.cbsa ? geo.cbsas.get(region.cbsa) : region.csa ? geo.csas.get(region.csa) : null;
  if ((region.cbsa || region.csa) && !metro) throw new Error(`Region ${region.id} names an unknown metro area`);
  for (const county of metro?.counties ?? []) counties.add(county);
  for (const county of counties) {
    if (!geo.counties.has(county)) throw new Error(`Region ${region.id} names unknown county ${county}`);
  }
  return {
    id: region.id,
    label: region.label,
    kind: region.kind,
    definition: region.definition,
    states: new Set(region.states ?? []),
    counties,
    excludeCounties: new Set(region.excludeCounties ?? []),
  };
}

// Region overrides (createRegionRegistry) get their own resolver instance.
export function createResolver({ regionOverrides = [] } = {}) {
  const geo = loadGeography();
  const registry = regionOverrides.length ? buildRegionIndex(geo, createRegionRegistry(regionOverrides)) : defaultRegions(geo);
  return {
    check: (input) => checkCoverage(geo, registry, input),
    describe: (input) => describeAreas(geo, registry, input),
  };
}

export function checkServiceArea(input) {
  const geo = loadGeography();
  return checkCoverage(geo, defaultRegions(geo), input);
}

export function describeServiceAreas(input) {
  const geo = loadGeography();
  return describeAreas(geo, defaultRegions(geo), input);
}

export function datasetInfo() {
  const geo = loadGeography();
  return { datasetVersion: geo.version, regionRegistryVersion: defaultRegions(geo).version };
}

// ---------------------------------------------------------------------------
// Parsing a location (caller words or a configured entry) into candidates
// ---------------------------------------------------------------------------

const ZIP_PATTERN = /(?<!\d)(\d{5})(?:[-\s]?\d{4})?(?!\d)/g;
const METRO_SUFFIX = / (metropolitan statistical area|metropolitan area|metro area|metro region|metroplex|metro|area|region|vicinity)$/;
const SURROUNDING = /\b(?:and |plus )?(?:the )?(?:surrounding|nearby|neighboring|neighbouring|outlying) (?:areas?|towns?|cities|communities|counties|suburbs|region)\b|\band (?:the )?(?:vicinity|suburbs)\b/g;
const LEADING_FILLERS = new Set(["in", "near", "around", "from", "at", "the", "out", "over", "by", "of", "just", "right",
  "im", "i", "am", "we", "are", "were", "live", "living", "located", "based", "calling", "its", "it", "is", "city", "town"]);
// Single words never taken as a place name when scanning a sentence.
const STOPWORDS = new Set([...LEADING_FILLERS, "a", "an", "and", "or", "but", "so", "my", "our", "your", "me", "you", "us",
  "here", "there", "today", "now", "yes", "no", "ok", "okay", "um", "uh", "like", "think", "area", "metro", "region",
  "county", "state", "zip", "code", "street", "road", "avenue", "ave", "st", "rd", "dr", "drive", "lane", "apt", "suite",
  "north", "south", "east", "west", "northern", "southern", "eastern", "western", "close", "outside", "inside", "part",
  "home", "house", "work", "office", "address", "place", "spot", "side", "downtown", "uptown", "center", "central",
  "new", "old", "little", "big", "great", "greater", "upper", "lower", "about", "actually", "really", "well"]);
// New York City boroughs are counties, not Census places.
const NYC_BOROUGHS = new Map([
  ["brooklyn", "36047"], ["manhattan", "36061"], ["queens", "36081"], ["bronx", "36005"], ["the bronx", "36005"], ["staten island", "36085"],
]);

// -> { zip, zipRow, candidates, unknownInState, explicitState, stateless, surrounding, areaSuffix, key }
// `scan` (caller speech only) also looks inside sentences and addresses;
// configured entries are taken as written.
function parseLocation(geo, registry, raw, { scan = false } = {}) {
  const original = String(raw ?? "");
  const zipMatches = [...original.matchAll(ZIP_PATTERN)];
  // The last five-digit group: a full address leads with the street number.
  const zip = zipMatches.length ? zipMatches[zipMatches.length - 1][1] : null;
  const withoutZip = zip ? original.replace(zipMatches[zipMatches.length - 1][0], " ") : original;
  const explicitAbbrs = new Set([
    ...[...withoutZip.matchAll(/\b([A-Z]{2})\b/g)].map((match) => match[1].toLowerCase()),
    ...[...withoutZip.matchAll(/,\s*([A-Za-z]{2})\b/g)].map((match) => match[1].toLowerCase()),
  ]);

  let key = basicNorm(withoutZip).replace(/\b(zip ?code|zip|postal code)\b/g, " ").replace(/\s+/g, " ").trim();
  let surrounding = false;
  key = key.replace(SURROUNDING, () => {
    surrounding = true;
    return " ";
  }).replace(/\s+/g, " ").trim();
  if (/^greater /.test(key)) {
    key = key.replace(/^greater /, "");
    surrounding = true;
  }

  const parsed = { zip, zipRow: zip ? geo.zips.get(zip) ?? null : null, key, surrounding, candidates: [], unknownInState: null };
  if (!key) return parsed;

  let result = resolvePhrase(geo, registry, key, explicitAbbrs);
  // "I'm in Silver Spring" - drop leading filler words one at a time.
  for (let rest = key; !result?.candidates.length && rest.includes(" ");) {
    const [first, ...others] = rest.split(" ");
    if (!LEADING_FILLERS.has(first)) break;
    rest = others.join(" ");
    const retry = resolvePhrase(geo, registry, rest, explicitAbbrs);
    if (retry && (retry.candidates.length || !result)) result = retry;
  }
  // A full address: "123 Main St, Silver Spring, MD" - drop leading
  // comma-separated parts until the rest resolves.
  const segments = withoutZip.split(",").map((segment) => basicNorm(segment)).filter(Boolean);
  for (let start = 1; scan && !result?.candidates.length && start < segments.length; start += 1) {
    const retry = resolvePhrase(geo, registry, segments.slice(start).join(" "), explicitAbbrs);
    // A bare trailing "MD" is the state already known, not a better answer.
    if (retry?.candidates.some((candidate) => candidate.type !== "state")) result = retry;
  }
  // Still nothing: find the place, county, state or region inside a
  // sentence ("calling from near Arlington today").
  if (scan && !result?.candidates.length) {
    const capitalized = new Set([...withoutZip.matchAll(/\b[A-Z][A-Za-z.'\u2019-]*/g)].map((match) => basicNorm(match[0])));
    const scanned = scanPhrase(geo, registry, result?.unknownInState ? result.rest : key, explicitAbbrs, result?.unknownInState, capitalized);
    if (scanned?.candidates.length) result = scanned;
  }
  return { ...parsed, ...result, surrounding: surrounding || Boolean(result?.areaSuffix) };
}

function resolvePhrase(geo, registry, phrase, explicitAbbrs, { keepSuffix = false } = {}) {
  if (!phrase) return null;
  const region = registry.lookup(phrase);
  if (region) return { candidates: [regionCandidate(region)] };

  const suffix = keepSuffix ? null : phrase.match(METRO_SUFFIX);
  const base = suffix && phrase !== suffix[0].trim() ? phrase.slice(0, -suffix[0].length) : phrase;
  if (suffix) {
    const baseRegion = registry.lookup(base);
    if (baseRegion) return { candidates: [regionCandidate(baseRegion)] };
  }

  if (base === "washington") {
    // Washington state or Washington, DC - context decides.
    return { candidates: [stateCandidate("WA"), dcCandidate()], stateless: true };
  }

  const split = splitState(geo, base, explicitAbbrs);
  const { state } = split;
  let rest = split.rest;
  if (state === "DC" && (!rest || rest === "washington" || rest === "city of washington")) {
    if (suffix) return metroResult(geo, "washington", "DC", base);
    return { candidates: [dcCandidate()], explicitState: "DC" };
  }
  if (!rest) return state ? { candidates: [stateCandidate(state)], explicitState: state } : null;

  if (suffix) {
    const metro = metroResult(geo, nameKey(rest), state, base);
    if (metro) return metro;
  }

  rest = rest.replace(/^(city|town|village|township) of /, "");
  const found = lookupNamed(geo, rest, state);
  if (found.length) {
    return {
      candidates: found,
      explicitState: state,
      stateless: !state,
      areaSuffix: Boolean(suffix),
    };
  }
  // "Capitol Planning Region" is a name, not "Capitol" plus a suffix.
  if (suffix) {
    const literal = resolvePhrase(geo, registry, phrase, explicitAbbrs, { keepSuffix: true });
    if (literal?.candidates.length) return literal;
  }
  return state ? { candidates: [], unknownInState: state, rest } : null;
}

function metroResult(geo, cityKey, state, phrase) {
  const metros = findMetros(geo, cityKey, state);
  if (!metros.length) return null;
  return { candidates: metros.map(metroCandidate), explicitState: state, stateless: !state, metroPhrase: phrase };
}

// Split a trailing state off: "silver spring maryland" -> { rest: "silver
// spring", state: "MD" }. Full names anywhere at the end; abbreviations only
// when they can't be an ordinary word (see WORD_ABBREVIATIONS).
function splitState(geo, phrase, explicitAbbrs) {
  if (phrase === "washington state" || phrase === "state of washington") return { rest: "", state: "WA" };
  const dc = phrase.match(/^(.*?)\s*\b(?:washington dc|washington district of columbia|district of columbia|dc)$/);
  if (dc) return { rest: dc[1].trim(), state: "DC" };
  const stateWord = phrase.match(/^(.*) (?:washington state)$/);
  if (stateWord) return { rest: stateWord[1], state: "WA" };
  const bare = phrase.replace(/^state of /, "").replace(/ state$/, "");
  if (STATE_NAME_KEYS.has(bare)) return { rest: "", state: STATE_NAME_KEYS.get(bare) };
  for (const name of STATE_NAMES_LONGEST_FIRST) {
    if (phrase.endsWith(` ${name}`)) {
      return { rest: phrase.slice(0, -name.length - 1).replace(/ (in|of)$/, "").trim(), state: STATE_NAME_KEYS.get(name) };
    }
  }
  const tokens = phrase.split(" ");
  const last = tokens[tokens.length - 1];
  const abbr = last.toUpperCase();
  if (last.length === 2 && STATE_BY_ABBR.has(abbr)) {
    const rest = tokens.slice(0, -1).join(" ").replace(/ (in|of)$/, "").trim();
    if (!rest) {
      return !WORD_ABBREVIATIONS.has(last) || explicitAbbrs.has(last) ? { rest: "", state: abbr } : { rest: phrase, state: null };
    }
    if (!WORD_ABBREVIATIONS.has(last) || explicitAbbrs.has(last) || lookupNamed(geo, rest, abbr).length) {
      return { rest, state: abbr };
    }
  }
  return { rest: phrase, state: null };
}

function isStateWord(token) {
  return STATE_BY_ABBR.has(token.toUpperCase()) || STATE_NAMES_LONGEST_FIRST.some((name) => name.split(" ").includes(token));
}

// Places, towns, counties and NYC boroughs named `phrase`, optionally in one state.
function lookupNamed(geo, phrase, state) {
  const key = nameKey(phrase);
  const inState = (item) => !state || item.state === state;

  const countyWord = key.match(/^(.+) (county|parish|borough|census area|planning region)$/);
  if (countyWord) return dedupeCounties((geo.countiesByKey.get(key) ?? geo.countiesByKey.get(countyWord[1]) ?? []).filter(inState)).map(countyCandidate);

  const borough = NYC_BOROUGHS.get(key);
  if (borough && (!state || state === "NY")) return [countyCandidate(geo.counties.get(borough))];

  let places = (geo.placesByKey.get(key) ?? []).filter(inState);
  if (!places.length) {
    const stripped = key.replace(/ (city|town|village|township|borough|cdp)$/, "");
    if (stripped !== key) places = (geo.placesByKey.get(stripped) ?? []).filter(inState);
  }
  if (places.length) return dedupePlaces(places).map(placeCandidate);

  // A county named without the word "county" ("Loudoun", "Prince George's").
  return dedupeCounties((geo.countiesByKey.get(key) ?? []).filter(inState)).map(countyCandidate);
}

// One candidate per name per state: a CDP and the township of the same
// name in the same state are the same place to a caller.
function dedupePlaces(places) {
  const byKey = new Map();
  for (const place of places) {
    const id = `${place.state}|${place.key}`;
    const existing = byKey.get(id);
    if (!existing) byKey.set(id, { ...place, counties: [...place.counties] });
    else for (const county of place.counties) if (!existing.counties.includes(county)) existing.counties.push(county);
  }
  return [...byKey.values()];
}

function dedupeCounties(counties) {
  return [...new Map(counties.map((county) => [county.geoid, county])).values()];
}

function findMetros(geo, cityKey, state) {
  let hits = (geo.metrosByKey.get(cityKey) ?? []).filter(({ metro }) => !state || metro.states.includes(state));
  if (!hits.length) return [];
  const cbsas = hits.filter(({ metro }) => metro.type === "cbsa");
  if (cbsas.length) hits = cbsas;
  const metropolitan = hits.filter(({ metro }) => metro.metropolitan);
  if (metropolitan.length) hits = metropolitan;
  const leading = hits.filter(({ start }) => start === 0);
  if (leading.length) hits = leading;
  return [...new Map(hits.map(({ metro }) => [`${metro.type}${metro.code}`, metro])).values()];
}

function scanPhrase(geo, registry, phrase, explicitAbbrs, state, capitalized) {
  const tokens = phrase.split(" ").filter(Boolean);
  for (let size = Math.min(tokens.length, 6); size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const window = tokens.slice(start, start + size);
      if (STOPWORDS.has(window[0]) || STOPWORDS.has(window[window.length - 1])) continue;
      const words = window.join(" ");
      if (size === 1 && words.length < 3) continue;
      // A place in a sentence is a proper noun: "by the lake" is not Lake, MS.
      if (!capitalized.has(window[0])) continue;
      // Only when every other word is filler: "near Arlington today" is
      // Arlington, but "Capitol Hill" is not "Hill".
      const others = [...tokens.slice(0, start), ...tokens.slice(start + size)];
      if (others.some((token) => !STOPWORDS.has(token) && !/\d/.test(token) && !isStateWord(token))) continue;
      const result = state
        ? { candidates: lookupNamed(geo, words, state), explicitState: state }
        : resolvePhrase(geo, registry, words, explicitAbbrs);
      if (result?.candidates.length) {
        // "... Silver Spring Maryland ..." - the state right after the place.
        if (!state && result.stateless) {
          const after = tokens.slice(start + size, start + size + 2).join(" ");
          const next = splitState(geo, `x ${after}`, explicitAbbrs);
          if (next.state && next.rest === "x") {
            const narrowed = lookupNamed(geo, words, next.state);
            if (narrowed.length) return { candidates: narrowed, explicitState: next.state };
          }
        }
        return result;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Candidates: one possible reading of what was said
// ---------------------------------------------------------------------------

function placeCandidate(place) {
  return {
    type: "place",
    label: `${place.name}, ${place.state}`,
    place: place.name,
    state: place.state,
    counties: place.counties,
    placeKey: `${place.state}|${place.key}`,
  };
}

function countyCandidate(county) {
  return { type: "county", label: `${county.name}, ${county.state}`, state: county.state, counties: [county.geoid], county: county.name };
}

function stateCandidate(abbr) {
  return { type: "state", label: STATE_BY_ABBR.get(abbr).name, state: abbr };
}

function dcCandidate() {
  return { type: "state", label: "Washington, DC", state: "DC", place: "Washington" };
}

function metroCandidate(metro) {
  return { type: "metro", label: metro.title, counties: [...metro.counties], states: metro.states, metro: metro.title };
}

function regionCandidate(region) {
  return {
    type: "region",
    label: region.label,
    regionStates: region.states,
    counties: [...region.counties],
    excludeCounties: region.excludeCounties,
    states: [...new Set([...region.states, ...[...region.counties].map(stateOfCounty)])],
  };
}

function zipCandidate(row) {
  return {
    type: "zip",
    label: row.zip,
    zip: row.zip,
    state: row.state,
    counties: [row.counties[0]],
    place: row.placeName,
    placeKey: row.placeName ? `${row.state}|${nameKey(row.placeName)}` : null,
  };
}

function candidateStates(candidate) {
  if (candidate.states) return candidate.states;
  return candidate.state ? [candidate.state] : [];
}

// ---------------------------------------------------------------------------
// Configured service areas
// ---------------------------------------------------------------------------

function emptyArea(entry, kind, label) {
  return { entry, kind, label, states: new Set(), counties: new Set(), excludeCounties: new Set(), zips: new Set(), places: new Set(), ambiguous: false };
}

// The business's own town and ZIP are always covered.
function businessArea(geo, registry, address) {
  if (typeof address !== "string" || !address.trim()) return null;
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const zip = [...last.matchAll(ZIP_PATTERN)].pop()?.[1] ?? null;
  const zipRow = zip ? geo.zips.get(zip) : null;
  const stateText = last.replace(ZIP_PATTERN, " ").trim();
  let state = splitState(geo, basicNorm(`x ${stateText}`), new Set([basicNorm(stateText)])).state ?? zipRow?.state ?? null;
  let city = "";
  if (parts.length >= 3) city = parts[parts.length - 2];
  else if (parts.length === 2) city = parts[1].replace(/\b[A-Z]{2}\b|\d{5}(-\d{4})?/g, "").trim();
  else if (!zip) return null;

  const area = emptyArea(address, "business_location", "the business's own town");
  if (zip) area.zips.add(zip);
  if (city) {
    const places = lookupNamed(geo, city, state ?? undefined).filter((candidate) => candidate.type === "place");
    for (const place of places) area.places.add(place.placeKey);
    if (!places.length) area.textKey = nameKey(city);
    if (!state && places.length === 1) state = places[0].state;
  }
  area.contextStates = new Set([state, zipRow?.state].filter(Boolean));
  return finishArea(geo, area);
}

function areaFromCandidates(geo, entry, candidates, { surrounding, parsedZip }) {
  if (parsedZip && !candidates.length) {
    const area = emptyArea(entry, "zip", parsedZip);
    area.zips.add(parsedZip);
    return finishArea(geo, area);
  }
  const first = candidates[0];
  let kind = first.type;
  // "Charleston and surrounding areas" / "Rockville area": the place's metro
  // area when it names one, otherwise the place's county.
  if (surrounding && first.type === "place") {
    const metros = candidates.flatMap((candidate) => findMetros(geo, nameKey(candidate.place), candidate.state));
    if (metros.length) return areaFromCandidates(geo, entry, metros.map(metroCandidate), {});
    kind = "county";
  }
  const area = emptyArea(entry, kind, candidates.map((candidate) => candidate.label).join(" or "));
  area.ambiguous = candidates.length > 1;
  for (const candidate of candidates) {
    if (candidate.type === "state") area.states.add(candidate.state);
    else if (candidate.type === "region") {
      for (const state of candidate.regionStates) area.states.add(state);
      for (const county of candidate.counties) area.counties.add(county);
      for (const county of candidate.excludeCounties) area.excludeCounties.add(county);
    } else if (candidate.type === "place" && kind === "place") area.places.add(candidate.placeKey);
    else if (candidate.type === "zip") area.zips.add(candidate.zip);
    else for (const county of candidate.counties ?? []) area.counties.add(county);
  }
  return finishArea(geo, area);
}

function finishArea(geo, area) {
  area.touchedStates = new Set([
    ...area.states,
    ...[...area.counties].map(stateOfCounty),
    ...[...area.places].map((key) => key.split("|")[0]),
    ...[...area.zips].map((zip) => geo.zips.get(zip)?.state).filter(Boolean),
  ]);
  area.touchedCounties = new Set([
    ...[...area.zips].flatMap((zip) => geo.zips.get(zip)?.counties ?? []),
    ...[...area.places].flatMap((key) => {
      const [state, name] = key.split("|");
      return (geo.placesByKey.get(name) ?? []).filter((place) => place.state === state).flatMap((place) => place.counties);
    }),
  ]);
  return area;
}

function resolveAreas(geo, registry, { serviceAreas, businessAddress }) {
  const business = businessArea(geo, registry, businessAddress);
  const parsed = serviceAreas.map((entry) => ({ entry, parsed: parseLocation(geo, registry, entry) }));

  // Context for a same-named configured place ("Charleston"): first the
  // business's own state and states named outright (a state, a "City, ST",
  // a county, a ZIP); failing that, being inside another listed area
  // ("Arlington" next to "Northern Virginia"). Failing both it stays
  // ambiguous and covers every reading, as plain text matching did.
  const strong = new Set(business?.contextStates ?? []);
  for (const { parsed: item } of parsed) {
    if (item.zipRow) strong.add(item.zipRow.state);
    if (item.candidates.length !== 1) continue;
    const [candidate] = item.candidates;
    if (candidate.type === "state" || candidate.type === "place" || candidate.type === "county") strong.add(candidate.state);
  }

  const areas = new Array(parsed.length);
  const unrecognized = [];
  const deferred = [];
  parsed.forEach(({ entry, parsed: item }, index) => {
    if (item.zip && (item.zipRow || !item.candidates.length)) {
      const area = emptyArea(entry, "zip", item.zip);
      area.zips.add(item.zip);
      areas[index] = finishArea(geo, area);
    } else if (item.candidates.length > 1) {
      deferred.push(index);
    } else if (item.candidates.length) {
      areas[index] = areaFromCandidates(geo, entry, item.candidates, { surrounding: item.surrounding });
    } else {
      // Not in the dataset ("Capitol Hill", "Somewhere, MD"): kept as text so
      // a caller repeating those words still matches, as before.
      unrecognized.push(entry);
      areas[index] = {
        ...emptyArea(entry, "place", entry),
        textKey: nameKey(item.unknownInState ? item.rest : entry),
        touchedStates: new Set(),
        touchedCounties: new Set(),
      };
    }
  });
  const settled = areas.filter(Boolean).filter((area) => area.textKey === undefined);
  for (const index of deferred) {
    const { entry, parsed: item } = parsed[index];
    let candidates = item.candidates.filter((candidate) => candidateStates(candidate).some((state) => strong.has(state)));
    if (!candidates.length) {
      candidates = item.candidates.filter((candidate) => settled.some((area) => evaluate(geo, candidate, area).verdict === "covered"));
    }
    areas[index] = areaFromCandidates(geo, entry, candidates.length ? candidates : item.candidates, { surrounding: item.surrounding });
  }
  if (business) areas.push(business);

  const contextStates = new Set(strong);
  const servedStates = new Set(strong);
  for (const area of areas) {
    for (const state of area.touchedStates) servedStates.add(state);
    if (area.kind === "state" || area.kind === "place" || area.kind === "county" || area.kind === "zip") {
      for (const state of area.touchedStates) contextStates.add(state);
    }
  }
  return { areas, unrecognized, contextStates, servedStates, business };
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

function countyIn(area, geoid) {
  return area.counties.has(geoid) || (area.states.has(stateOfCounty(geoid)) && !area.excludeCounties.has(geoid));
}

function stateCoverage(geo, area, state) {
  const counties = geo.countiesByState.get(state) ?? [];
  const covered = counties.filter((county) => countyIn(area, county)).length;
  if (covered === counties.length && counties.length) return "covered";
  if (covered || area.touchedStates.has(state)) return "partial";
  return "outside";
}

function countiesCoverage(area, counties) {
  const covered = counties.filter((county) => countyIn(area, county)).length;
  if (covered === counties.length) return "covered";
  if (covered) return "partial";
  return counties.some((county) => area.touchedCounties.has(county)) ? "partial" : "outside";
}

function evaluate(geo, candidate, area) {
  if (area.textKey !== undefined) return { verdict: "outside" };
  const by = area.kind;
  const covered = (matchedBy) => ({ verdict: "covered", by: matchedBy, area });
  switch (candidate.type) {
    case "zip":
      if (area.zips.has(candidate.zip)) return covered(area.kind === "business_location" ? by : "zip");
      if (candidate.placeKey && area.places.has(candidate.placeKey)) return covered(area.kind === "business_location" ? by : "place");
      return countyIn(area, candidate.counties[0]) ? covered(by) : { verdict: "outside" };
    case "place": {
      if (area.places.has(candidate.placeKey)) return covered(area.kind === "business_location" ? by : "place");
      const verdict = candidate.counties.length
        ? countiesCoverage(area, candidate.counties)
        : stateCoverage(geo, area, candidate.state);
      if (verdict === "covered") return covered(by);
      if (verdict === "outside" && (geo.zipsByPlace.get(candidate.placeKey) ?? []).some((zip) => area.zips.has(zip))) {
        return { verdict: "partial" };
      }
      return { verdict };
    }
    case "county": {
      const verdict = countiesCoverage(area, candidate.counties);
      return verdict === "covered" ? covered(by) : { verdict };
    }
    case "state": {
      const verdict = stateCoverage(geo, area, candidate.state);
      return verdict === "covered" ? covered(by) : { verdict };
    }
    default: {
      // metro / region named by the caller: covered only if all of it is.
      const footprint = new Set(candidate.counties);
      for (const state of candidate.regionStates ?? []) {
        for (const county of geo.countiesByState.get(state) ?? []) {
          if (!candidate.excludeCounties?.has(county)) footprint.add(county);
        }
      }
      const verdict = countiesCoverage(area, [...footprint]);
      return verdict === "covered" ? covered(by) : { verdict };
    }
  }
}

function bestCoverage(geo, candidate, areas) {
  let best = null;
  let partial = false;
  for (const area of areas) {
    const result = evaluate(geo, candidate, area);
    if (result.verdict === "covered") {
      if (!best || MATCH_RANK[result.by] < MATCH_RANK[best.by]) best = result;
    } else if (result.verdict === "partial") {
      partial = true;
    }
  }
  return best ?? { verdict: partial ? "partial" : "outside" };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function checkCoverage(geo, registry, { location, serviceAreas = [], businessAddress = "" }) {
  const config = resolveAreas(geo, registry, { serviceAreas, businessAddress });
  const parsed = parseLocation(geo, registry, location, { scan: true });
  const callerKey = nameKey(location);

  // 1. Exact ZIP (ZIP+4 compares on its five-digit base), even for ZIPs
  //    with no Census ZCTA (PO boxes, single-building ZIPs).
  if (parsed.zip) {
    const area = config.areas.find((item) => item.zips.has(parsed.zip));
    if (area) {
      const candidate = parsed.zipRow ? zipCandidate(parsed.zipRow) : { type: "zip", zip: parsed.zip };
      return respond(geo, "covered", { candidate, area, by: area.kind === "business_location" ? "business_location" : "zip", confidence: "exact" });
    }
  }

  // A configured entry the dataset doesn't know ("Capitol Hill") still
  // matches when the caller says those exact words.
  const textArea = config.areas.find((area) => area.textKey && containsWholeWords(callerKey, area.textKey));
  if (textArea) return respond(geo, "covered", { area: textArea, by: "place", confidence: "exact" });

  let candidates = parsed.zipRow ? [zipCandidate(parsed.zipRow)] : parsed.candidates;
  if (parsed.zip && !parsed.zipRow && !candidates.length) {
    return respond(geo, "unresolved", {
      question: "I couldn't match that ZIP code. Could you repeat it, or tell me the town?",
    });
  }

  if (!candidates.length) {
    if (parsed.unknownInState) return unknownPlaceInState(geo, config, parsed);
    return unresolved(geo, config, parsed.key, null);
  }

  const evaluations = candidates.map((candidate) => ({ candidate, ...bestCoverage(geo, candidate, config.areas) }));
  const single = evaluations.length === 1;
  const stateless = Boolean(parsed.stateless) && !parsed.zipRow;
  const inContext = (evaluation) => evaluation.verdict !== "outside"
    || candidateStates(evaluation.candidate).some((state) => config.contextStates.has(state));
  const plausible = evaluations.filter(inContext);

  if (!plausible.length) {
    // Every reading is outside and none is near the business - unless it's
    // likely a mishearing of a nearby place ("Silver Springs").
    const suggestion = parsed.zipRow ? null : nearMiss(geo, config, parsed.key);
    if (suggestion) {
      return respond(geo, "ambiguous", {
        question: `Did you mean ${suggestion.place}, ${STATE_BY_ABBR.get(suggestion.state).name}? If not, which state is that in, or what's the ZIP code?`,
        suggestion,
      });
    }
    return respond(geo, "outside", {
      candidate: single ? evaluations[0].candidate : null,
      confidence: single && !stateless ? "exact" : "contextual",
    });
  }

  if (plausible.every((evaluation) => evaluation.verdict === "covered")) {
    const best = plausible.reduce((winner, evaluation) =>
      (MATCH_RANK[evaluation.by] < MATCH_RANK[winner.by] ? evaluation : winner));
    return respond(geo, "covered", {
      candidate: plausible.length === 1 ? best.candidate : sharedCandidate(plausible.map((evaluation) => evaluation.candidate)),
      area: best.area,
      by: best.by,
      confidence: single && !stateless ? "exact" : "contextual",
    });
  }

  if (plausible.length === 1) {
    const [only] = plausible;
    if (only.verdict === "partial") {
      return respond(geo, "ambiguous", { candidate: only.candidate, question: partialQuestion(only.candidate) });
    }
    return respond(geo, "outside", { candidate: only.candidate, confidence: single && !stateless ? "exact" : "contextual" });
  }

  const states = new Set(plausible.flatMap((evaluation) => candidateStates(evaluation.candidate)));
  return respond(geo, "ambiguous", {
    question: states.size <= 1 && plausible.every((evaluation) => evaluation.candidate.type !== "state") ? ASK_ZIP : ASK_STATE_OR_ZIP,
    candidates: plausible.map((evaluation) => evaluation.candidate.label),
  });
}

function partialQuestion(candidate) {
  if (candidate.type === "state") {
    return `Which city or town in ${STATE_BY_ABBR.get(candidate.state).name} is that, or what's the ZIP code?`;
  }
  return ASK_ZIP;
}

// The caller gave a state but a town the dataset doesn't know.
function unknownPlaceInState(geo, config, parsed) {
  const state = parsed.unknownInState;
  const coverage = config.areas.map((area) => (area.textKey === undefined ? { area, verdict: stateCoverage(geo, area, state) } : null)).filter(Boolean);
  const whole = coverage.find((item) => item.verdict === "covered");
  // Every town in a fully covered state is covered, and every town in a
  // state nobody serves is outside - the town's name changes neither.
  if (whole) {
    return respond(geo, "covered", { candidate: stateCandidate(state), area: whole.area, by: whole.area.kind, confidence: "contextual" });
  }
  if (!coverage.some((item) => item.verdict === "partial")) {
    return respond(geo, "outside", { candidate: stateCandidate(state), confidence: "contextual" });
  }
  return unresolved(geo, config, parsed.rest, state);
}

function unresolved(geo, config, key, state) {
  const suggestion = nearMiss(geo, config, key, state);
  return respond(geo, "unresolved", {
    candidate: state ? stateCandidate(state) : null,
    question: suggestion ? `Sorry, did you say ${suggestion.place}?` : ASK_SPELLING,
    suggestion,
  });
}

// Closest real place name in the states this business works in - for a
// likely speech-to-text slip ("Silver Springs", "Stafferd").
function nearMiss(geo, config, key, state) {
  const target = nameKey(key ?? "");
  if (target.length < 4) return null;
  const states = state ? [state] : [...config.servedStates];
  const limit = target.length <= 8 ? 1 : 2;
  let best = null;
  const consider = (key, name, abbr, rank) => {
    if (key === target || Math.abs(key.length - target.length) > limit || key[0] !== target[0]) return;
    const distance = editDistance(key, target, limit);
    if (distance <= limit && (!best || distance < best.distance || (distance === best.distance && rank < best.rank))) {
      best = { place: name, state: abbr, distance, rank };
    }
  };
  for (const abbr of states) {
    for (const place of geo.placesByState.get(abbr) ?? []) consider(place.key, place.name, abbr, place.town ? 1 : 0);
    for (const geoid of geo.countiesByState.get(abbr) ?? []) {
      const county = geo.counties.get(geoid);
      consider(countyBaseKey(county.name), county.name, abbr, 2);
    }
  }
  return best ? { place: best.place, state: best.state } : null;
}

function editDistance(a, b, limit) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function sharedCandidate(candidates) {
  const [first] = candidates;
  const same = (field) => (candidates.every((candidate) => candidate[field] === first[field]) ? first[field] : null);
  return { type: "shared", place: same("place"), state: same("state") };
}

function containsWholeWords(haystack, needle) {
  if (!needle || (needle.length <= 2 && !needle.includes(" "))) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function respond(geo, status, { candidate = null, area = null, by = null, confidence = null, question = "", suggestion = null, candidates = null }) {
  const result = {
    ok: true,
    matched: status === "covered",
    status,
    canonicalLocation: canonical(geo, candidate),
    matchedBy: status === "covered" ? by : null,
    matchedArea: status === "covered" && area ? (area.kind === "business_location" ? "the business's own town" : area.entry) : null,
    confidence: confidence ?? (status === "covered" || status === "outside" ? "contextual" : "ambiguous"),
    message: status === "covered" ? COVERED_MESSAGE : status === "outside" ? OUTSIDE_MESSAGE : "",
    clarificationQuestion: status === "ambiguous" || status === "unresolved" ? question : "",
  };
  if (suggestion) result.suggestion = `${suggestion.place}, ${suggestion.state}`;
  if (candidates) result.candidates = candidates;
  return result;
}

function canonical(geo, candidate) {
  if (!candidate) return null;
  const county = candidate.counties?.length === 1 || candidate.type === "zip" || candidate.type === "place"
    ? geo.counties.get(primaryCounty(geo, candidate))
    : null;
  const cbsa = county ? geo.cbsas.get(geo.countyCbsa.get(county.geoid)) : null;
  return {
    place: candidate.place ?? null,
    state: candidate.state ?? null,
    zip: candidate.zip ?? null,
    county: candidate.type === "metro" || candidate.type === "region" ? null : county?.name ?? null,
    metro: candidate.type === "metro" ? candidate.metro : cbsa?.metropolitan ? cbsa.title : null,
    ...(candidate.type === "region" ? { region: candidate.label } : {}),
  };
}

// A place spanning several counties is reported in the one most of its ZIP
// codes sit in (Columbus, OH -> Franklin County).
function primaryCounty(geo, candidate) {
  if (candidate.type !== "place" || candidate.counties.length < 2) return candidate.counties?.[0];
  const votes = new Map();
  for (const zip of geo.zipsByPlace.get(candidate.placeKey) ?? []) {
    const county = geo.zips.get(zip).counties[0];
    if (candidate.counties.includes(county)) votes.set(county, (votes.get(county) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? candidate.counties[0];
}

// ---------------------------------------------------------------------------
// Preview: what each configured entry was understood to include
// ---------------------------------------------------------------------------

function describeAreas(geo, registry, { serviceAreas = [], businessAddress = "" }) {
  const { areas } = resolveAreas(geo, registry, { serviceAreas, businessAddress });
  return areas.map((area) => ({
    entry: area.kind === "business_location" ? null : area.entry,
    kind: area.textKey !== undefined ? "unrecognized" : area.kind,
    label: area.label,
    ambiguous: area.ambiguous,
    states: [...area.states].sort(),
    counties: [...area.counties].map((geoid) => `${geo.counties.get(geoid).name}, ${geo.counties.get(geoid).state}`).sort(),
    excludedCounties: [...area.excludeCounties].map((geoid) => `${geo.counties.get(geoid).name}, ${geo.counties.get(geoid).state}`).sort(),
    places: [...area.places].map((key) => key.split("|").reverse().join(", ")).sort(),
    zips: [...area.zips].sort(),
  }));
}
