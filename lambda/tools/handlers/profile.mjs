// Mirror of effectiveProfile in lambda/bff/receptionist.mjs - this Lambda is
// packaged separately. An agent's own Business Profile (timezone, address,
// forwarding number, ...) wins; an agent that hasn't saved one yet falls back
// to the workspace profile. Profile fields no screen can edit (they only ever
// held sample data) are never used.
const AGENT_PROFILE_FIELDS = [
  "businessName",
  "phone",
  "address",
  "mailingAddress",
  "website",
  "timezone",
  "contactEmails",
  "serviceAreas",
  "businessHours",
  "hours",
  "holidays",
  "holidaysEnabled",
  "ownerPhone",
];

const UNEDITABLE_PROFILE_FIELDS = [
  "description",
  "faqs",
  "policies",
  "escalationContact",
  "fallbackPhone",
  "communicationStyle",
  "businessType",
];

export function effectiveProfile(agent, workspaceProfile) {
  const merged = { ...(workspaceProfile ?? {}) };
  for (const field of UNEDITABLE_PROFILE_FIELDS) delete merged[field];
  const own = agent?.configuration?.businessProfile;
  if (own && typeof own === "object") {
    for (const field of AGENT_PROFILE_FIELDS) {
      if (own[field] !== undefined) merged[field] = own[field];
    }
  }
  return merged;
}
