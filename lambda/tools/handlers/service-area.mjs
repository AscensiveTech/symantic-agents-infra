import { checkServiceArea } from "../geo/resolver.mjs";
import { ToolRequestError, requireString } from "./errors.mjs";

// Read-only, side-effect-free - no store access, no idempotency needed;
// calling it twice for the same input is harmless. The configured list
// travels with the tool definition itself (baked in as a `const` schema
// property at agent create/update time - see serviceAreaTool in
// lambda/bff/voice-agent/tools.mjs), so there's no database lookup here.
//
// The decision is deterministic: geo/resolver.mjs resolves the caller's
// words and every configured entry against a local, versioned Census
// dataset (states, counties, places, ZIPs, OMB metro areas, named regions)
// and returns covered / outside / ambiguous / unresolved. The model follows
// the status; it never decides coverage from its own geography.
//
// `ok` and `matched` (= status "covered") are kept for agents published
// before `status` existed.
export async function handleServiceArea(input) {
  const location = requireString(input.location, "location");
  const serviceAreas = parseServiceAreas(input.serviceAreas);
  return checkServiceArea({
    location,
    serviceAreas,
    // The business's own town and ZIP are always covered (absent on agents
    // published before it was baked into the tool).
    businessAddress: typeof input.businessAddress === "string" ? input.businessAddress : "",
  });
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
