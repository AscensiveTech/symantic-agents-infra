// Amazon Location Service (Places v2) for the call-time coverage check.
// The AWS SDK client ships with the Lambda Node.js runtime, so it is
// imported on first use rather than bundled. Results are never stored -
// Geocode runs with the default IntendedUse (SingleUse) - and only kept in
// this container's memory for an hour so a caller repeating a place, or the
// business address on every check, doesn't cost a second request.

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 500;

let clientPromise;

export function createPlacesClient({ send } = {}) {
  const cache = new Map();
  const sendCommand = send ?? defaultSend;

  async function geocode({ text, biasPosition, countries, language, maxResults = 5 }) {
    const request = {
      QueryText: String(text).slice(0, 200),
      MaxResults: maxResults,
      ...(biasPosition ? { BiasPosition: biasPosition } : {}),
      ...(countries?.length ? { Filter: { IncludeCountries: countries.slice(0, 100) } } : {}),
      ...(language ? { Language: language } : {}),
    };
    const key = JSON.stringify(request);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    const response = await sendCommand("Geocode", request);
    const items = Array.isArray(response?.ResultItems) ? response.ResultItems : [];
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { items, expires: Date.now() + CACHE_TTL_MS });
    return items;
  }

  return { geocode };
}

async function defaultSend(operation, input) {
  clientPromise ??= import("@aws-sdk/client-geo-places").then((sdk) => ({
    client: new sdk.GeoPlacesClient({}),
    commands: { Geocode: sdk.GeocodeCommand },
  }));
  const { client, commands } = await clientPromise;
  return client.send(new commands[operation](input));
}
