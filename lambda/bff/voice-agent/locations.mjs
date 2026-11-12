// Multi-location agents. One Retell agent (one prompt, one number) can answer
// for up to MAX_LOCATIONS locations - e.g. two offices that both forward to
// the same receptionist.
//
// Location 1 is the agent's existing top-level Business Profile fields (so a
// single-location agent is unchanged and nothing needs migrating), named by
// `locationName`. Locations 2..N live in `additionalLocations`, each with the
// same per-location field names:
//
// Each location may go by its own business name (`businessName`; Location 1's
// is `locationBusinessName`) - blank means the agent-wide Company Name.
//
//   { id, name, businessName, phone, address, mailingAddress, website, timezone,
//     contactEmails, serviceZones, businessHours, holidays, holidaysEnabled }
//
// Mirrored in lib/domain/locations.ts (frontend) and tools/handlers/locations.mjs.

export const MAX_LOCATIONS = 10;

export const LOCATION_FIELDS = Object.freeze([
  "phone",
  "address",
  "mailingAddress",
  "website",
  "timezone",
  "contactEmails",
  "serviceZones",
  "businessHours",
  "hours",
  "holidays",
  "holidaysEnabled",
]);

// Every location as one list, Location 1 first. Entries without an object
// shape are skipped; the list never exceeds MAX_LOCATIONS.
export function profileLocations(profile) {
  if (!profile || typeof profile !== "object") return [];
  const first = { id: "location-1", name: text(profile.locationName), businessName: text(profile.locationBusinessName) };
  for (const field of LOCATION_FIELDS) if (profile[field] !== undefined) first[field] = profile[field];
  const extra = Array.isArray(profile.additionalLocations)
    ? profile.additionalLocations.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
  const locations = [first, ...extra.map((entry, index) => {
    const location = { id: text(entry.id) || `location-${index + 2}`, name: text(entry.name), businessName: text(entry.businessName) };
    for (const field of LOCATION_FIELDS) if (entry[field] !== undefined) location[field] = entry[field];
    return location;
  })].slice(0, MAX_LOCATIONS);
  return locations.map((location, index) => ({ ...location, name: location.name || `Location ${index + 1}` }));
}

export function hasMultipleLocations(profile) {
  return profileLocations(profile).length > 1;
}

function text(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}
