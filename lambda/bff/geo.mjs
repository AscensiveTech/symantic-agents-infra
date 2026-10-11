// Map search for the Service Area editor (Amazon Location Service, Places v2).
//
//   GET  /workspaces/me/geo/config   -> map style URL (browser maps key) + region
//   POST /workspaces/me/geo/search   -> places / addresses as the user types
//   POST /workspaces/me/geo/place    -> one place's address components, to save as a zone
//   POST /workspaces/me/geo/reverse  -> what's at a point (the country/region of a drawn shape)
//
// Places calls go through here, signed with the Lambda's role, so no places
// key reaches the browser. The browser only gets a maps key restricted to map
// tiles and to this app's domains (location.tf). Anything saved
// long-term (place and reverse lookups) is requested with IntendedUse
// "Storage", which Amazon Location's terms require for stored results.

const AREA_TYPES = new Set(["Country", "Region", "SubRegion", "Locality", "District", "SubDistrict", "PostalCode"]);
const MAX_QUERY = 200;
const KEY_TTL_MS = 60 * 60 * 1000;

let sdkPromise;

async function defaultSend(operation, input) {
  sdkPromise ??= Promise.all([import("@aws-sdk/client-geo-places"), import("@aws-sdk/client-location")]).then(([places, location]) => ({
    places: new places.GeoPlacesClient({}),
    location: new location.LocationClient({}),
    commands: {
      Suggest: places.SuggestCommand,
      Autocomplete: places.AutocompleteCommand,
      GetPlace: places.GetPlaceCommand,
      ReverseGeocode: places.ReverseGeocodeCommand,
      DescribeKey: location.DescribeKeyCommand,
    },
  }));
  const sdk = await sdkPromise;
  const client = operation === "DescribeKey" ? sdk.location : sdk.places;
  return client.send(new sdk.commands[operation](input));
}

export function createGeoService({
  send = defaultSend,
  region = process.env.AWS_REGION,
  mapsKeyName = process.env.LOCATION_MAPS_KEY_NAME,
  now = () => Date.now(),
} = {}) {
  let keyCache = null;

  async function mapsKey() {
    if (!mapsKeyName) return null;
    if (keyCache && keyCache.expires > now()) return keyCache.key;
    const response = await send("DescribeKey", { KeyName: mapsKeyName });
    keyCache = { key: response?.Key ?? null, expires: now() + KEY_TTL_MS };
    return keyCache.key;
  }

  async function config() {
    const key = await mapsKey();
    if (!key || !region) return null;
    return {
      region,
      mapStyleUrl: `https://maps.geo.${region}.amazonaws.com/v2/styles/Standard/descriptor?key=${encodeURIComponent(key)}`,
    };
  }

  // mode "area": countries, regions, counties, cities, neighbourhoods and
  // postal codes (Suggest finds counties, Autocomplete is better at postal
  // codes - both, merged). mode "address": street addresses and towns, for a
  // radius center.
  async function search({ text, mode = "area", biasPosition, countries, language }) {
    const query = typeof text === "string" ? text.trim().slice(0, MAX_QUERY) : "";
    if (!query) return [];
    const common = {
      QueryText: query,
      BiasPosition: isPosition(biasPosition) ? biasPosition : [0, 0],
      ...(language ? { Language: language } : {}),
    };
    const countryFilter = Array.isArray(countries) && countries.length
      ? countries.filter((code) => /^[A-Z]{2,3}$/.test(code)).slice(0, 100)
      : [];

    if (mode === "address") {
      const response = await send("Autocomplete", {
        ...common,
        MaxResults: 8,
        ...(countryFilter.length ? { Filter: { IncludeCountries: countryFilter } } : {}),
      });
      return (response?.ResultItems ?? []).map((item) => ({ placeId: item.PlaceId, placeType: item.PlaceType, title: item.Title }));
    }

    const [suggested, completed] = await Promise.all([
      send("Suggest", {
        ...common,
        MaxResults: 8,
        ...(countryFilter.length ? { Filter: { IncludeCountries: countryFilter } } : {}),
      }),
      send("Autocomplete", {
        ...common,
        MaxResults: 8,
        Filter: {
          IncludePlaceTypes: ["Country", "Region", "Locality", "PostalCode"],
          ...(countryFilter.length ? { IncludeCountries: countryFilter } : {}),
        },
      }),
    ]);
    const results = [];
    const seen = new Set();
    const add = (placeId, placeType, title) => {
      if (!placeId || !AREA_TYPES.has(placeType) || seen.has(placeId)) return;
      seen.add(placeId);
      results.push({ placeId, placeType, title });
    };
    for (const item of suggested?.ResultItems ?? []) {
      if (item.Place) add(item.Place.PlaceId, item.Place.PlaceType, item.Title);
    }
    for (const item of completed?.ResultItems ?? []) add(item.PlaceId, item.PlaceType, item.Title);
    return results.slice(0, 10);
  }

  async function place({ placeId, language }) {
    if (typeof placeId !== "string" || !placeId || placeId.length > 500) return null;
    const response = await send("GetPlace", {
      PlaceId: placeId,
      IntendedUse: "Storage",
      ...(language ? { Language: language } : {}),
    });
    return toZonePlace(response);
  }

  async function reverse({ position, language }) {
    if (!isPosition(position)) return null;
    const response = await send("ReverseGeocode", {
      QueryPosition: position,
      MaxResults: 1,
      IntendedUse: "Storage",
      ...(language ? { Language: language } : {}),
    });
    const [item] = response?.ResultItems ?? [];
    if (!item) return null;
    const address = item.Address ?? {};
    return {
      title: item.Title ?? address.Label ?? "",
      locality: address.Locality ?? null,
      area: address.Country?.Code3
        ? { countryCode: address.Country.Code3, regionCode: address.Region?.Code ?? null, regionName: address.Region?.Name ?? null }
        : null,
    };
  }

  return { config, search, place, reverse };
}

// GetPlace response -> the zone fields saved in serviceZones.
export function toZonePlace(item) {
  if (!item || !AREA_TYPES.has(item.PlaceType)) return null;
  const address = item.Address ?? {};
  return {
    label: zoneLabel(item.PlaceType, address) || item.Title || address.Label || "",
    place: {
      placeId: item.PlaceId ?? null,
      placeType: item.PlaceType,
      countryCode: address.Country?.Code3 ?? null,
      countryName: address.Country?.Name ?? null,
      regionCode: address.Region?.Code ?? null,
      regionName: address.Region?.Name ?? null,
      subRegionName: address.SubRegion?.Name ?? null,
      locality: address.Locality ?? null,
      district: address.District ?? null,
      postalCode: address.PostalCode ?? null,
    },
    position: isPosition(item.Position) ? item.Position : null,
    mapView: Array.isArray(item.MapView) && item.MapView.length === 4 ? item.MapView : null,
  };
}

// "Maryland, United States", "Montgomery, Maryland", "Silver Spring, Maryland",
// "M1 4, Manchester" - from the components, since a Title can be as terse as
// "MD, United States".
function zoneLabel(placeType, address) {
  const country = address.Country?.Name;
  const region = address.Region?.Name;
  const parts = {
    Country: [country],
    Region: [region, country],
    SubRegion: [address.SubRegion?.Name, region],
    Locality: [address.Locality, region ?? country],
    District: [address.District, address.Locality ?? region],
    SubDistrict: [address.SubDistrict ?? address.District, address.Locality ?? region],
    PostalCode: [address.PostalCode, address.Locality ?? region],
  }[placeType];
  return parts?.[0] ? parts.filter(Boolean).join(", ") : "";
}

function isPosition(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

// Route handler, called from index.mjs for /workspaces/me/geo/*.
export async function handleGeoRoute({ path, method, body, geo, json }) {
  try {
    if (path === "/workspaces/me/geo/config" && method === "GET") {
      const config = await geo.config();
      return config ? json(200, config) : json(503, { message: "Maps aren't set up yet" });
    }
    if (path === "/workspaces/me/geo/search" && method === "POST") {
      return json(200, { results: await geo.search(body ?? {}) });
    }
    if (path === "/workspaces/me/geo/place" && method === "POST") {
      const result = await geo.place(body ?? {});
      return result ? json(200, result) : json(404, { message: "That place can't be used as a service area" });
    }
    if (path === "/workspaces/me/geo/reverse" && method === "POST") {
      const result = await geo.reverse(body ?? {});
      return result ? json(200, result) : json(404, { message: "Nothing found at that point" });
    }
    return json(404, { message: "Not found" });
  } catch (error) {
    if (error?.name === "ThrottlingException") return json(429, { message: "Map search is busy - try again in a moment" });
    if (error?.name === "ValidationException") return json(400, { message: "That search couldn't be run" });
    console.error("Map search failed", { path, name: error?.name, message: error?.message });
    return json(502, { message: "Map search is unavailable right now" });
  }
}
