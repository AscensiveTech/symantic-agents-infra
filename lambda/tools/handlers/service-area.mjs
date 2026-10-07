import { ToolRequestError, requireString } from "./errors.mjs";

// Read-only, side-effect-free - no store access, no idempotency needed;
// calling it twice for the same input is harmless. The configured list
// travels with the tool definition itself (baked in as a `const` schema
// property at agent create/update time - see buildServiceAreaTool in
// lambda/bff/receptionist.mjs), so there's no database lookup here at
// all: zero added latency, zero added cost, pure string comparison.
//
// Deliberately conservative: this is a fast path for clear hits only,
// not a definitive verdict. Anything not confidently matched comes back
// `matched: false` with no message, and the model falls back to its own
// judgment over the full list already in its prompt (the `# SERVICE
// AREA` section) - exactly what it did before this tool existed.
export async function handleServiceArea(input) {
  const location = requireString(input.location, "location");
  const serviceAreas = parseServiceAreas(input.serviceAreas);

  const normalizedLocation = normalize(location);
  const locationZip = extractZip(location);
  const locationStates = statesIn(location);

  // The business's own town is always covered (baked into the tool like
  // serviceAreas; absent on agents published before it existed).
  const business = parseAddress(typeof input.businessAddress === "string" ? input.businessAddress : "");
  if (business.zip && locationZip === business.zip) return matchedResponse();
  if (business.city && containsWholeWord(normalizedLocation, normalize(business.city))) return matchedResponse();

  for (const area of serviceAreas) {
    // A whole state ("Maryland", "MD") covers any place given with that state.
    const areaState = stateOf(area);
    if (areaState) {
      if (locationStates.has(areaState)) return matchedResponse();
      continue;
    }
    const areaZip = extractZip(area);
    // extractZip only ever captures the 5-digit base, so a configured
    // ZIP+4 entry ("22201-1234") already reduces to "22201" here - a
    // plain equality check is the "prefix match" this needs.
    if (locationZip && areaZip) {
      if (locationZip === areaZip) return matchedResponse();
      continue;
    }
    if (locationZip || areaZip) continue;

    const areaCity = normalize(area.split(",")[0] ?? area);
    if (!areaCity) continue;
    if (normalizedLocation === areaCity || containsWholeWord(normalizedLocation, areaCity)) {
      return matchedResponse();
    }
  }

  return {
    ok: true,
    matched: false,
    message: "",
    hint: "No exact text match. That alone isn't a no: a metro area includes its suburbs and nearby towns, and a "
      + "state includes every town in it - decide from where the place actually is.",
  };
}

const US_STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_ABBREVIATIONS = new Set(Object.values(US_STATES));
// Longest first, so "west virginia" is found before "virginia".
const STATE_NAMES = Object.keys(US_STATES).sort((a, b) => b.length - a.length);

// The state an area entry names on its own ("Maryland", "MD"), or null.
function stateOf(area) {
  const normalized = normalize(area).replace(/^state of /, "");
  if (US_STATES[normalized]) return US_STATES[normalized];
  const upper = area.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) && STATE_ABBREVIATIONS.has(upper) ? upper : null;
}

// States a caller's location mentions: full names anywhere ("Beltsville,
// Maryland"), abbreviations only as the trailing token ("Beltsville, MD",
// "Beltsville MD 20705") so ordinary words like "in" or "me" never count.
function statesIn(location) {
  const states = new Set();
  let rest = normalize(location).replace(/\bwashington d ?c\b|\bdc\b/g, () => {
    states.add("DC");
    return " ";
  });
  for (const name of STATE_NAMES) {
    if (containsWholeWord(rest, name)) {
      states.add(US_STATES[name]);
      rest = rest.replace(new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|$)`), " ");
    }
  }
  const trailing = location.trim().match(/(?:^|[\s,])([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (trailing && STATE_ABBREVIATIONS.has(trailing[1])) states.add(trailing[1]);
  return states;
}

// "10901 Rhode Island Ave, Beltsville, MD 20705" -> { city: "Beltsville", zip: "20705" }
function parseAddress(address) {
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  // The ZIP sits in the last part - the street number can look like one too.
  const zip = parts.length ? extractZip(parts[parts.length - 1]) : null;
  if (parts.length >= 3) return { city: parts[parts.length - 2], zip };
  if (parts.length === 2) return { city: parts[1].replace(/\b[A-Z]{2}\b|\d{5}(-\d{4})?/g, "").trim(), zip };
  return { city: "", zip };
}

function matchedResponse() {
  return { ok: true, matched: true, message: "That location is within our published service area." };
}

function parseServiceAreas(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ToolRequestError("serviceAreas is required", { transportError: true });
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch {
    return [];
  }
}

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A 5-digit or 5+4 ZIP, anywhere in the string - callers say "two two
// two oh one" as digits, not spelled out, so a simple digit-run check is
// enough without needing to parse the rest of the sentence.
function extractZip(value) {
  const match = value.match(/\b(\d{5})(-?\d{4})?\b/);
  return match ? match[1] : null;
}

function containsWholeWord(haystack, needle) {
  if (!needle.includes(" ") && needle.length <= 2) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(needle)}(\\s|$)`).test(haystack);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
