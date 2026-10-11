// Amazon Location Service (Places v2) for the call-time coverage check,
// called over its REST API with a SigV4-signed request (aws-request.mjs) -
// no SDK needed in the deployment package. Results are never stored -
// Geocode runs with the default IntendedUse (SingleUse) - and only kept in
// this container's memory for an hour so a caller repeating a place, or the
// business address on every check, doesn't cost a second request.

import { awsRequest } from "./aws-request.mjs";

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 500;

// A coverage check has to answer inside the tool's 10 s budget, with room
// for the caller's lookup and the business address.
const GEOCODE_TIMEOUT_MS = 4000;

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
  if (operation !== "Geocode") throw new Error(`Unsupported operation ${operation}`);
  const region = process.env.AWS_REGION;
  return awsRequest({
    service: "geo-places",
    host: `places.geo.${region}.amazonaws.com`,
    path: "/v2/geocode",
    body: input,
    region,
    timeoutMs: GEOCODE_TIMEOUT_MS,
  });
}
