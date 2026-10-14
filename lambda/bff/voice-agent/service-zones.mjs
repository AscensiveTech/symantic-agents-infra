// Service-area zones ("Exact Coverage" on the map), as saved in a Business
// Profile's serviceZones. Shape-checked and bounded here; the tools Lambda
// (tools/geo/coverage.mjs) does the coverage check against them at call time.
//
//   { id, type: "place", label, place: { placeId, placeType, countryCode,
//     countryName, regionCode, regionName, subRegionName, locality, district,
//     postalCode }, position: [lng, lat], mapView: [w, s, e, n] }
//   { id, type: "radius", label, center: [lng, lat], radiusMeters, unit: "km" | "mi", area }
//   { id, type: "polygon", label, coordinates: [[lng, lat], ...], area }
//
// `area` on a shape is the country and region it sits in (reverse geocoded
// when drawn), used to narrow and disambiguate the caller's place.

export const MAX_ZONES = 50;
export const MAX_POLYGON_VERTICES = 250;
export const MAX_TOTAL_VERTICES = 2000;
export const MIN_RADIUS_METERS = 100;
export const MAX_RADIUS_METERS = 500_000;

const PLACE_TYPES = new Set(["Country", "Region", "SubRegion", "Locality", "District", "SubDistrict", "PostalCode"]);

export function sanitizeServiceZones(value) {
  if (!Array.isArray(value)) return [];
  const zones = [];
  let vertices = 0;
  for (const raw of value) {
    if (zones.length >= MAX_ZONES) break;
    const zone = sanitizeZone(raw);
    if (!zone) continue;
    if (zone.type === "polygon") {
      if (vertices + zone.coordinates.length > MAX_TOTAL_VERTICES) continue;
      vertices += zone.coordinates.length;
    }
    zones.push(zone);
  }
  return zones;
}

function sanitizeZone(raw) {
  if (!raw || typeof raw !== "object") return null;
  const base = { id: bounded(raw.id, 64) || randomId(), label: bounded(raw.label, 200) };
  if (raw.type === "place") {
    const place = sanitizePlace(raw.place);
    if (!place) return null;
    return {
      ...base,
      type: "place",
      label: base.label || place.locality || place.subRegionName || place.regionName || place.postalCode || place.countryName || "",
      place,
      ...(isPosition(raw.position) ? { position: roundPosition(raw.position) } : {}),
      ...(isMapView(raw.mapView) ? { mapView: raw.mapView.map(round6) } : {}),
    };
  }
  if (raw.type === "radius") {
    if (!isPosition(raw.center) || !Number.isFinite(raw.radiusMeters)) return null;
    const radiusMeters = Math.min(MAX_RADIUS_METERS, Math.max(MIN_RADIUS_METERS, Math.round(raw.radiusMeters)));
    return {
      ...base,
      type: "radius",
      center: roundPosition(raw.center),
      radiusMeters,
      unit: raw.unit === "mi" ? "mi" : "km",
      ...(sanitizeArea(raw.area) ? { area: sanitizeArea(raw.area) } : {}),
    };
  }
  if (raw.type === "polygon") {
    if (!Array.isArray(raw.coordinates)) return null;
    let coordinates = raw.coordinates.filter(isPosition).map(roundPosition);
    // Stored open: a closing vertex equal to the first is dropped.
    if (coordinates.length > 1 && samePosition(coordinates[0], coordinates[coordinates.length - 1])) coordinates = coordinates.slice(0, -1);
    if (coordinates.length < 3 || coordinates.length > MAX_POLYGON_VERTICES) return null;
    return {
      ...base,
      type: "polygon",
      coordinates,
      ...(sanitizeArea(raw.area) ? { area: sanitizeArea(raw.area) } : {}),
    };
  }
  return null;
}

function sanitizePlace(raw) {
  if (!raw || typeof raw !== "object" || !PLACE_TYPES.has(raw.placeType)) return null;
  const place = {
    placeId: bounded(raw.placeId, 500) || null,
    placeType: raw.placeType,
    countryCode: countryCode(raw.countryCode),
    countryName: bounded(raw.countryName, 120) || null,
    regionCode: bounded(raw.regionCode, 20) || null,
    regionName: bounded(raw.regionName, 120) || null,
    subRegionName: bounded(raw.subRegionName, 120) || null,
    locality: bounded(raw.locality, 120) || null,
    district: bounded(raw.district, 120) || null,
    postalCode: bounded(raw.postalCode, 20) || null,
  };
  if (!place.countryCode) return null;
  if (place.placeType === "PostalCode" && !place.postalCode) return null;
  if (place.placeType === "Locality" && !place.locality) return null;
  if (place.placeType === "Region" && !place.regionName && !place.regionCode) return null;
  if (place.placeType === "SubRegion" && !place.subRegionName) return null;
  return place;
}

function sanitizeArea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = countryCode(raw.countryCode);
  if (!code) return null;
  return {
    countryCode: code,
    regionCode: bounded(raw.regionCode, 20) || null,
    regionName: bounded(raw.regionName, 120) || null,
  };
}

function countryCode(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

function bounded(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isPosition(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function isMapView(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function roundPosition([lng, lat]) {
  return [round6(lng), round6(lat)];
}

function samePosition(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function randomId() {
  return `zone-${Math.random().toString(36).slice(2, 10)}`;
}

// How one zone is said when a caller asks where the business serves. A
// radius is said with its distance ("within 10 miles of Silver Spring") -
// never as just its center town, which would undersell it. A drawn area
// still named with the editor's placeholder ("Drawn area 2") says nothing.
export function spokenZoneName(zone) {
  if (!zone?.label) return "";
  if (zone.type === "radius") return `within ${formatDistance(zone.radiusMeters, zone.unit)} of ${zone.label}`;
  if (zone.type === "polygon" && /^drawn area\s*\d*$/i.test(zone.label)) return "";
  return zone.label;
}

// 16093 m in miles -> "10 miles"; 2500 m in km -> "2.5 km".
export function formatDistance(meters, unit) {
  const value = unit === "mi" ? meters / 1609.344 : meters / 1000;
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  if (unit === "mi") return `${rounded} ${rounded === 1 ? "mile" : "miles"}`;
  return `${rounded} km`;
}

