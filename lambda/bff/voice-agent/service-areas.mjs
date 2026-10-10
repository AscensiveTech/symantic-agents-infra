// Service Area text -> entries. Mirror of parseServiceAreaInput in the
// frontend (lib/domain/service-areas.ts): one area per line is the primary
// format; a single line is split on commas, except that "City, ST" stays one
// entry. Used when Exact Coverage is blank, so the coverage check reads the
// places out of the "What Callers Hear" text instead.

// Both boxes are capped at this many characters (the frontend matches).
export const SERVICE_AREA_TEXT_LIMIT = 3000;

const STATES = [
  ["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"], ["California", "CA"],
  ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"], ["District of Columbia", "DC"],
  ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"], ["Illinois", "IL"],
  ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"], ["Kentucky", "KY"], ["Louisiana", "LA"],
  ["Maine", "ME"], ["Maryland", "MD"], ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"],
  ["Mississippi", "MS"], ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"],
  ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"],
  ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"], ["Oregon", "OR"],
  ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"], ["South Dakota", "SD"],
  ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"], ["Vermont", "VT"], ["Virginia", "VA"],
  ["Washington", "WA"], ["West Virginia", "WV"], ["Wisconsin", "WI"], ["Wyoming", "WY"],
];

const STATE_ALTERNATIVES = [...STATES.flatMap(([name, abbr]) => [name.replace(/ /g, "\\s+"), abbr]), "D\\.\\s*C"]
  .sort((a, b) => b.length - a.length)
  .join("|");
const STATE_SEGMENT = new RegExp(
  `^(?:${STATE_ALTERNATIVES})\\.?(?:\\s+\\d{5}(?:-\\d{4})?)?(?:\\s+(?:and|&)\\s+(?:the\\s+)?(?:surrounding|nearby)\\s+areas?)?$`,
  "i",
);
const ENDS_WITH_STATE = new RegExp(`(?:^|[\\s,])(?:${STATE_ALTERNATIVES})\\.?$`, "i");
const REGION_ENTRY = /\b(?:metro|metropolitan|area|areas|region|coast|states|dmv|nova|socal|norcal|midwest|mid ?west|northeast|southeast|southwest|northwest|new england|bay area|mid-?atlantic)\b|\d{5}/i;

export function parseServiceAreaText(text) {
  const source = typeof text === "string" ? text.slice(0, SERVICE_AREA_TEXT_LIMIT) : "";
  const entries = source.includes("\n") ? source.split("\n") : joinCityState(source.split(","));
  return entries
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

// Exact Coverage entries as saved: trimmed, blanks dropped, and kept only
// while the whole list (one per line) fits SERVICE_AREA_TEXT_LIMIT.
export function boundServiceAreas(list) {
  if (!Array.isArray(list)) return [];
  const kept = [];
  let length = 0;
  for (const item of list) {
    if (typeof item !== "string") continue;
    const entry = item.trim();
    if (!entry) continue;
    const next = length + (kept.length ? 1 : 0) + entry.length;
    if (next > SERVICE_AREA_TEXT_LIMIT) break;
    kept.push(entry);
    length = next;
  }
  return kept;
}

function joinCityState(segments) {
  const entries = [];
  for (const raw of segments) {
    const segment = raw.trim();
    const previous = entries[entries.length - 1];
    const washingtonDc = /^washington$/i.test(previous ?? "") && /^(?:D\.?\s*C\.?|District of Columbia)$/i.test(segment);
    if (
      previous !== undefined
      && segment
      && STATE_SEGMENT.test(segment)
      && (washingtonDc || (!STATE_SEGMENT.test(previous) && !ENDS_WITH_STATE.test(previous) && !REGION_ENTRY.test(previous)))
    ) {
      entries[entries.length - 1] = `${previous}, ${segment}`;
    } else {
      entries.push(segment);
    }
  }
  return entries;
}
