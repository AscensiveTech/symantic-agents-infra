import { checkCoverage, normalizeGeocodeItem, regionKey } from "../geo/coverage.mjs";
import { createPlacesClient } from "../geo/places-client.mjs";
import { requireString } from "./errors.mjs";
import { effectiveProfile } from "./profile.mjs";

// Read-only, side-effect-free. The zones come from the agent's *published*
// configuration (agent.configuration, not the autosaved draft), read at call
// time like the transfer and booking tools do - a drawn outline can be
// hundreds of points, far too big to bake into the tool definition the model
// sees on every turn.
//
// The caller's words are geocoded with Amazon Location and checked against
// the zones (geo/coverage.mjs). The model follows the returned status; it
// never decides coverage from its own geography.
//
// Agents published before map zones existed send their text list as the
// `serviceAreas` const. Those entries are geocoded here too, so they keep
// working until the agent is re-saved with zones.

const defaultPlaces = createPlacesClient();

export async function handleServiceArea(input, { store, places = defaultPlaces } = {}) {
  const location = requireString(input.location, "location");
  const legacyEntries = parseServiceAreas(input.serviceAreas);

  const [agent, workspaceProfile] = store && input.workspaceId
    ? await Promise.all([
      store.getAgent(input.workspaceId, typeof input.agentId === "string" && input.agentId ? input.agentId : undefined),
      store.getBusinessProfile(input.workspaceId),
    ])
    : [null, null];
  const profile = agent || workspaceProfile ? effectiveProfile(agent, workspaceProfile) : {};
  const zones = readZones(profile.serviceZones);
  const language = agent?.configuration?.language === "es-419" ? "es" : "en";
  const businessAddress = typeof input.businessAddress === "string" && input.businessAddress.trim()
    ? input.businessAddress
    : typeof profile.address === "string" ? profile.address : "";

  // The business's own town and postal code are always covered.
  const business = businessAddress ? await geocodeBest(places, businessAddress, { language }) : null;
  const businessZones = business ? businessTownZones(business) : [];

  const countries = zoneCountries([...zones, ...businessZones]);
  const biasPosition = business?.position ?? zones.map(zoneAnchor).find(Boolean) ?? null;

  // Legacy text entries: placed on the map when they geocode to a real
  // area, otherwise kept as words a caller can repeat.
  const legacyZones = [];
  const legacyText = [];
  if (!zones.length) {
    const resolved = await Promise.all(legacyEntries.map((entry) => geocodeBest(places, entry, { language, biasPosition, countries })));
    resolved.forEach((result, index) => {
      if (result && result.level <= 4) legacyZones.push(placeZoneFromResult(result, legacyEntries[index]));
      else legacyText.push(legacyEntries[index]);
    });
  }

  const allZones = [...zones, ...legacyZones, ...businessZones];
  const allCountries = zoneCountries(allZones);
  const contextRegions = new Set(allZones
    .map((zone) => zone.place ?? zone.area)
    .filter((place) => place?.countryCode && (place.regionCode || place.regionName))
    .map((place) => regionKey(place)));

  return checkCoverage({
    location,
    zones: allZones,
    legacyText,
    contextRegions,
    usOnly: allCountries.length === 1 && allCountries[0] === "USA",
    geocode: (text) => places.geocode({ text, biasPosition, countries: allCountries, language }),
  });
}

// For the business address and older text entries: a failed lookup leaves
// that one item out rather than failing the caller's check. (A failure on the
// caller's own words does fail the check - the prompt then says the team will
// confirm coverage, never a guess.)
async function geocodeBest(places, text, options) {
  let items;
  try {
    items = await places.geocode({ text, maxResults: 1, ...options });
  } catch (error) {
    console.error("Service-area lookup skipped", { name: error?.name, message: error?.message });
    return null;
  }
  const [first] = items.map(normalizeGeocodeItem).filter((result) => result.placeType !== "PointOfInterest");
  return first && first.score >= 0.9 ? first : null;
}

function businessTownZones(result) {
  const zones = [];
  if (result.locality) {
    zones.push({
      type: "place",
      business: true,
      label: "the business's own town",
      place: { ...placeFields(result), placeType: "Locality", district: null, postalCode: null },
    });
  }
  if (result.postalCode && result.level >= 4) {
    zones.push({
      type: "place",
      business: true,
      label: "the business's own town",
      place: { ...placeFields(result), placeType: "PostalCode" },
      position: result.position,
    });
  }
  return zones;
}

function placeZoneFromResult(result, label) {
  return { type: "place", label, place: placeFields(result), position: result.position, mapView: result.mapView };
}

function placeFields(result) {
  return {
    placeType: result.placeType,
    countryCode: result.countryCode,
    regionCode: result.regionCode,
    regionName: result.regionName,
    subRegionName: result.subRegionName,
    locality: result.locality,
    district: result.district,
    postalCode: result.postalCode,
  };
}

function zoneCountries(zones) {
  // A shape saved without a country (shouldn't happen) means "don't filter".
  if (zones.some((zone) => zone.type !== "place" && !zone.area?.countryCode)) return [];
  return [...new Set(zones.map((zone) => zone.place?.countryCode ?? zone.area?.countryCode).filter(Boolean))];
}

function zoneAnchor(zone) {
  if (zone.type === "radius") return zone.center;
  if (zone.type === "polygon") return zone.coordinates[0];
  return zone.position ?? null;
}

// Zones were validated when saved (BFF voice-agent/service-zones.mjs); this
// only drops anything malformed rather than failing the call.
function readZones(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((zone) => {
    if (!zone || typeof zone !== "object") return false;
    if (zone.type === "place") return Boolean(zone.place?.placeType);
    if (zone.type === "radius") return isPosition(zone.center) && Number.isFinite(zone.radiusMeters) && zone.radiusMeters > 0;
    if (zone.type === "polygon") return Array.isArray(zone.coordinates) && zone.coordinates.length >= 3 && zone.coordinates.every(isPosition);
    return false;
  });
}

function isPosition(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

function parseServiceAreas(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}
