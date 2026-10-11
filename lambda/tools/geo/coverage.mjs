// Worldwide service-area coverage check.
//
// A business's service area is a list of zones (profile.serviceZones):
//   - place:   a named area picked from Amazon Location search - a country,
//              state/province/region, county/district (SubRegion), city or
//              town (Locality), neighbourhood (District) or postal code -
//              saved with its address components;
//   - radius:  a circle (center + meters);
//   - polygon: an outline drawn on the map.
//
// The caller's words are geocoded (Amazon Location Geocode, biased to the
// business and limited to the countries the business serves). A named place
// is matched the way Google Business Profile and field-service tools match
// service areas - by its address components (is the caller's postal code /
// city / region one of ours?) - because no provider publishes the outline of
// a city or postal code. Radius and polygon zones are matched by position.
//
// Same contract as before: status covered | outside | ambiguous | unresolved,
// plus ok/matched for agents published before `status` existed.

export const COVERED_MESSAGE = "That location is within our published service area.";
export const OUTSIDE_MESSAGE = "We don't currently serve that area - it's outside our service area. If you'd like, I "
  + "can take your address and have the team review it.";

// A geocoder match this good is a real place; below it, a guess.
const ACCEPT_SCORE = 0.9;
// Shown as "did you mean" only above this.
const SUGGEST_SCORE = 0.6;
// Close runners-up are read as the same question ("Silver Spring": MD or PA?).
const TIE_MARGIN = 0.05;

const LEVEL = {
  Country: 0,
  Region: 1,
  SubRegion: 2,
  Locality: 3,
  District: 4,
  PostalCode: 4,
  SubDistrict: 5,
};
const POINT_LEVEL = 6; // streets, addresses, intersections, blocks

export function placeLevel(placeType) {
  return LEVEL[placeType] ?? POINT_LEVEL;
}

// matchedBy for each kind of zone.
function matchedBy(zone) {
  if (zone.business) return "business_location";
  if (zone.type !== "place") return zone.type;
  const type = zone.place?.placeType;
  if (type === "PostalCode") return "postal_code";
  if (type === "Country" || type === "Region" || type === "SubRegion") return "region";
  return "place";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function norm(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function postalKey(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// "SW1A" covers "SW1A 1AA"; "20910" covers "20910-1234".
function postalCovers(zonePostal, resultPostal) {
  const zone = postalKey(zonePostal);
  const result = postalKey(resultPostal);
  return Boolean(zone) && result.startsWith(zone);
}

// Amazon Location result item -> the fields the check needs.
export function normalizeGeocodeItem(item) {
  const address = item?.Address ?? {};
  return {
    placeId: item?.PlaceId ?? null,
    placeType: item?.PlaceType ?? null,
    level: placeLevel(item?.PlaceType),
    title: item?.Title ?? address.Label ?? "",
    score: typeof item?.MatchScores?.Overall === "number" ? item.MatchScores.Overall : 1,
    countryCode: address.Country?.Code3 ?? null,
    countryCode2: address.Country?.Code2 ?? null,
    countryName: address.Country?.Name ?? null,
    regionCode: address.Region?.Code ?? null,
    regionName: address.Region?.Name ?? null,
    subRegionName: address.SubRegion?.Name ?? null,
    locality: address.Locality ?? null,
    district: address.District ?? null,
    postalCode: address.PostalCode ?? null,
    position: validPosition(item?.Position) ? item.Position : null,
    mapView: validMapView(item?.MapView) ? item.MapView : null,
  };
}

function validPosition(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

function validMapView(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;

export function distanceMeters([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Ray casting on lng/lat - exact enough for service areas, which are far
// smaller than a hemisphere and never cross the antimeridian.
export function pointInPolygon([lng, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inMapView([lng, lat], [west, south, east, north]) {
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function shapeContains(zone, point) {
  if (zone.type === "radius") return distanceMeters(zone.center, point) <= zone.radiusMeters;
  return pointInPolygon(point, zone.coordinates);
}

// A point inside the shape, to test whether the shape sits inside an area.
function shapeAnchor(zone) {
  return zone.type === "radius" ? zone.center : zone.coordinates[0];
}

// ---------------------------------------------------------------------------
// One geocoded place against one zone: covered / partial / outside.
// "partial" means the place is bigger than the zone and only part of it is
// served - the answer depends on where in it the caller is.
// ---------------------------------------------------------------------------

function sameRegion(zonePlace, result) {
  if (zonePlace.regionCode && result.regionCode) return zonePlace.regionCode === result.regionCode;
  if (zonePlace.regionName && result.regionName) return norm(zonePlace.regionName) === norm(result.regionName);
  return true;
}

function sameName(a, b) {
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

function placeZoneVerdict(zone, result) {
  const place = zone.place;
  if (place.countryCode && result.countryCode && place.countryCode !== result.countryCode) return "outside";
  const zoneLevel = placeLevel(place.placeType);

  if (place.placeType === "PostalCode") {
    if (result.level >= LEVEL.PostalCode && result.postalCode) {
      return postalCovers(place.postalCode, result.postalCode) ? "covered" : "outside";
    }
    // A town or region named: covered only in the part that has this code.
    return zone.position && result.mapView && inMapView(zone.position, result.mapView) ? "partial" : "outside";
  }

  // The result is inside the zone when every component that defines the
  // zone matches. A coarser result that contains the zone is partial.
  const checks = [];
  if (zoneLevel >= LEVEL.Region) checks.push(["region", sameRegion(place, result), result.level >= LEVEL.Region]);
  if (zoneLevel >= LEVEL.SubRegion) {
    checks.push(["subRegion", !result.subRegionName || !place.subRegionName || sameName(place.subRegionName, result.subRegionName), result.level >= LEVEL.SubRegion]);
  }
  if (zoneLevel >= LEVEL.Locality) checks.push(["locality", sameName(place.locality, result.locality), result.level >= LEVEL.Locality]);
  // A postal code doesn't say which neighbourhood it's in.
  if (zoneLevel >= LEVEL.District) {
    checks.push(["district", sameName(place.district, result.district), result.level >= LEVEL.District && result.placeType !== "PostalCode"]);
  }

  // SubRegion zones where the result carries no sub-region (some countries
  // don't fill it): fall back to position.
  if (place.placeType === "SubRegion" && result.level >= LEVEL.SubRegion && !result.subRegionName) {
    if (!sameRegion(place, result)) return "outside";
    return zone.mapView && result.position && inMapView(result.position, zone.mapView) ? "partial" : "outside";
  }

  for (const [, matches, resultHasLevel] of checks) {
    if (!resultHasLevel) return "partial"; // caller named something bigger, all matching so far
    if (!matches) return "outside";
  }
  return "covered";
}

function shapeZoneVerdict(zone, result) {
  if (!result.position) return "outside";
  const pointLike = result.level >= LEVEL.District || !result.mapView;
  if (pointLike) return shapeContains(zone, result.position) ? "covered" : "outside";

  const [west, south, east, north] = result.mapView;
  const corners = [[west, south], [west, north], [east, south], [east, north]];
  const cornersInside = corners.filter((corner) => shapeContains(zone, corner)).length;
  const centerInside = shapeContains(zone, result.position);
  if (cornersInside === corners.length) return "covered";
  // A town whose center is inside is treated as served; the team confirms
  // the exact address. A whole county or region needs a closer answer.
  if (centerInside && result.level >= LEVEL.Locality) return "covered";
  if (centerInside || cornersInside) return "partial";
  return inMapView(shapeAnchor(zone), result.mapView) ? "partial" : "outside";
}

export function zoneVerdict(zone, result) {
  return zone.type === "place" ? placeZoneVerdict(zone, result) : shapeZoneVerdict(zone, result);
}

function bestVerdict(zones, result) {
  let partial = false;
  for (const zone of zones) {
    const verdict = zoneVerdict(zone, result);
    if (verdict === "covered") return { verdict, zone };
    if (verdict === "partial") partial = true;
  }
  return { verdict: partial ? "partial" : "outside", zone: null };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

// zones:        sanitized serviceZones (plus the business's own town, flagged
//               `business: true`)
// legacyText:   configured entries that couldn't be placed on the map - a
//               caller saying exactly those words is still covered
// geocode:      async (text) -> Amazon Location result items, already biased
//               and country-filtered by the caller of this function
// contextRegions: Set of "COUNTRY|REGION" keys where the business works, to
//               pick between same-named places
export async function checkCoverage({ location, zones, legacyText = [], geocode, contextRegions = new Set(), usOnly = false }) {
  const spoken = norm(location);
  const textMatch = legacyText.find((entry) => containsWholeWords(spoken, norm(entry)));
  if (textMatch) return respond("covered", { by: "place", area: textMatch, confidence: "exact" });

  const items = await geocode(location);
  const results = items
    .map(normalizeGeocodeItem)
    // A business or landmark name is never a service-area answer ("Northern
    // Virginia" geocodes to companies with that in their name).
    .filter((result) => result.placeType && result.placeType !== "PointOfInterest");
  const top = results.reduce((best, result) => (result.score > (best?.score ?? -1) ? result : best), null);

  if (!top || top.score < ACCEPT_SCORE) {
    const suggestion = top && top.score >= SUGGEST_SCORE ? top : null;
    return respond("unresolved", {
      question: suggestion
        ? `Sorry, did you say ${spokenName(suggestion)}?`
        : `Could you spell the name of the town for me, or give me the ${usOnly ? "ZIP" : "postal"} code?`,
      suggestion,
    });
  }

  const candidates = dedupe(results.filter((result) => result.score >= Math.max(ACCEPT_SCORE, top.score - TIE_MARGIN)));
  const evaluated = candidates.map((result) => ({ result, ...bestVerdict(zones, result) }));
  const single = evaluated.length === 1;
  const inContext = (item) => item.verdict !== "outside" || contextRegions.has(regionKey(item.result));
  const plausible = single ? evaluated : evaluated.filter(inContext);

  if (!plausible.length) {
    return respond("outside", { result: evaluated[0].result, confidence: "contextual" });
  }
  if (plausible.every((item) => item.verdict === "covered")) {
    const [first] = plausible;
    return respond("covered", {
      result: first.result,
      by: matchedBy(first.zone),
      area: first.zone.label,
      confidence: single ? "exact" : "contextual",
    });
  }
  // Several readings near the business, none of them served - outside
  // whichever it is ("Richmond, Virginia": the city or the county).
  if (plausible.every((item) => item.verdict === "outside")) {
    return respond("outside", { result: plausible[0].result, confidence: "contextual" });
  }
  if (plausible.length === 1) {
    const [only] = plausible;
    if (only.verdict === "partial") {
      return respond("ambiguous", { result: only.result, question: partialQuestion(only.result, usOnly) });
    }
    return respond("outside", { result: only.result, confidence: single ? "exact" : "contextual" });
  }
  return respond("ambiguous", {
    question: usOnly ? "Which state is that in, or what's the ZIP code?" : "Which state or province is that in, or what's the postal code?",
    candidates: plausible.map((item) => item.result.title),
  });
}

function partialQuestion(result, usOnly) {
  const code = usOnly ? "ZIP code" : "postal code";
  if (result.level <= LEVEL.SubRegion) {
    return `Which city or town in ${spokenName(result)} is that, or what's the ${code}?`;
  }
  return `What's the ${code} there?`;
}

// "Silver Spring, Maryland" - how the place is said, not the full label.
function spokenName(result) {
  if (result.placeType === "Country") return result.countryName ?? result.title;
  if (result.placeType === "Region") return result.regionName ?? result.title;
  if (result.placeType === "SubRegion") return result.subRegionName ?? result.title;
  if (result.placeType === "PostalCode") return result.postalCode ?? result.title;
  const name = result.district && result.level >= LEVEL.District ? result.district : result.locality;
  return name && result.regionName ? `${name}, ${result.regionName}` : result.title;
}

export function regionKey(result) {
  return `${result.countryCode ?? ""}|${result.regionCode ?? norm(result.regionName)}`;
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = result.placeId ?? `${result.title}|${result.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function containsWholeWords(haystack, needle) {
  if (!needle || needle.length < 3) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function respond(status, { result = null, by = null, area = null, confidence = null, question = "", suggestion = null, candidates = null }) {
  const response = {
    ok: true,
    matched: status === "covered",
    status,
    canonicalLocation: result ? canonical(result) : null,
    matchedBy: status === "covered" ? by : null,
    matchedArea: status === "covered" ? area : null,
    confidence: confidence ?? (status === "covered" || status === "outside" ? "contextual" : "ambiguous"),
    message: status === "covered" ? COVERED_MESSAGE : status === "outside" ? OUTSIDE_MESSAGE : "",
    clarificationQuestion: status === "ambiguous" || status === "unresolved" ? question : "",
  };
  if (suggestion) response.suggestion = spokenName(suggestion);
  if (candidates) response.candidates = candidates;
  return response;
}

function canonical(result) {
  return {
    label: result.title,
    place: result.district && result.level >= LEVEL.District ? result.district : result.locality,
    locality: result.locality,
    county: result.subRegionName,
    region: result.regionName,
    regionCode: result.regionCode,
    country: result.countryName,
    countryCode: result.countryCode,
    postalCode: result.level >= LEVEL.PostalCode ? result.postalCode : null,
  };
}
