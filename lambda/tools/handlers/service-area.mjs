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

  for (const area of serviceAreas) {
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

  return { ok: true, matched: false, message: "" };
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
