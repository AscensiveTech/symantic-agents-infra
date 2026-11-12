import { checkCoverage, normalizeGeocodeItem, regionKey } from "../geo/coverage.mjs";
import { createPlacesClient } from "../geo/places-client.mjs";
import { requireString } from "./errors.mjs";
import { profileLocations } from "./locations.mjs";
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
  const language = agent?.configuration?.language === "es-419" ? "es" : "en";
  const locations = profileLocations(profile);
  const multiLocation = locations.length > 1;
  // With several locations every zone is tagged with its location, so a
  // covered answer can say which location serves the caller.
  const zones = multiLocation
    ? locations.flatMap((entry) => readZones(entry.serviceZones).map((zone) => ({ ...zone, locationName: entry.name })))
    : readZones(profile.serviceZones);
  const businessAddress = typeof input.businessAddress === "string" && input.businessAddress.trim() && !multiLocation
    ? input.businessAddress
    : typeof profile.address === "string" ? profile.address : "";
  const addresses = multiLocation
    ? locations.map((entry) => ({ address: typeof entry.address === "string" ? entry.address.trim() : "", locationName: entry.name }))
      .filter((entry) => entry.address)
    : businessAddress ? [{ address: businessAddress, locationName: null }] : [];

  // Each location's own town and postal code are always covered.
  const geocodedAddresses = await Promise.all(addresses.map((entry) => geocodeBest(places, entry.address, { language })));
  const business = geocodedAddresses.find(Boolean) ?? null;
  const businessZones = geocodedAddresses.flatMap((result, index) => (result
    ? businessTownZones(result).map((zone) => (addresses[index].locationName ? { ...zone, locationName: addresses[index].locationName } : zone))
    : []));

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
  // States a ZIP list reaches count as places the business works.
  for (const zone of allZones) {
    if (zone.type !== "postalList") continue;
    for (const entry of zone.codes) if (entry?.regionCode) contextRegions.add(regionKey({ countryCode: "USA", regionCode: entry.regionCode }));
  }

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
  // ZIP lists are US-only.
  if (zones.some((zone) => zone.type !== "place" && zone.type !== "postalList" && !zone.area?.countryCode)) return [];
  return [...new Set(zones.map((zone) => (zone.type === "postalList" ? "USA" : zone.place?.countryCode ?? zone.area?.countryCode)).filter(Boolean))];
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
    if (zone.type === "postalList") return Array.isArray(zone.codes) && zone.codes.some((entry) => typeof entry?.code === "string");
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
