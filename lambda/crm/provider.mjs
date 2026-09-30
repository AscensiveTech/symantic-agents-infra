// The receptionist's view of a CRM. The sync worker and the call-time lookup
// only ever talk to this contract; everything provider-specific (GraphQL,
// board and column ids, label names, token formats) lives in that provider's
// adapter folder. Adding HubSpot or Salesforce means adding an adapter that
// implements these methods and registering it below - nothing else changes.
//
// Domain shapes (plain objects, no provider types):
//
//   CrmContact   { externalId, name, phoneE164?, email?, status?, ownerName?, url? }
//   CrmLeadInput { name, phoneE164, email?, fields: CrmFieldPatch, isNew: true }
//   CrmFieldPatch {
//     lastCallAt?: ISO string,           // owned by us
//     outcome?: string,                   // owned by us
//     followUpDate?: "YYYY-MM-DD",        // owned by us
//     nextAppointmentAt?: ISO string | null  (null clears it)
//     status?: "new_lead" | "follow_up",  // semantic; the adapter maps to a label
//     assignDefaultOwner?: boolean,       // only ever true on creation
//     source?: string,                    // only on creation
//   }
//   CrmActivity  { ref, title, occurredAt, html }
//
// A "session" is { accessToken, mapping } for one tenant, opened by the
// provider's session factory. Methods throw CrmError (see errors.mjs).
//
// Provider methods:
//   findContactByPhone(session, phoneE164)          -> CrmContact | null
//   findContactByEmail(session, email)              -> CrmContact | null
//   getContact(session, externalId)                 -> CrmContact | null
//   createLead(session, CrmLeadInput, { idempotencyKey }) -> CrmContact
//   logCallActivity(session, externalId, CrmActivity,
//                   { fields?: CrmFieldPatch, idempotencyKey })
//                                                   -> { activityId, fieldsApplied, fieldsError? }
//   findActivityByRef(session, externalId, ref)     -> activityId | null
//   (connection management: describeAccount, listBoards, validateMapping,
//    suggestMapping - used only by the settings API, not by the domain.)

const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "findContactByPhone",
  "findContactByEmail",
  "getContact",
  "createLead",
  "logCallActivity",
  "findActivityByRef",
]);

export function assertCrmProvider(provider) {
  const missing = REQUIRED_PROVIDER_METHODS.filter(
    (method) => typeof provider?.[method] !== "function",
  );
  if (missing.length || typeof provider?.id !== "string") {
    throw new TypeError(`CRM provider is missing: ${missing.join(", ") || "id"}`);
  }
  return provider;
}

export function createProviderRegistry(providers) {
  const byId = new Map();
  for (const provider of providers) {
    assertCrmProvider(provider);
    byId.set(provider.id, provider);
  }
  return {
    // Accepts a provider id ("monday") or a connection key ("monday#agent-1").
    get(id) {
      return byId.get(providerIdOf(id)) ?? null;
    },
    ids() {
      return [...byId.keys()];
    },
  };
}

// Each agent has its own CRM connection. Its row key (the connections
// table's `provider` range key) is "<provider>#<agentId>".
export function connectionKeyFor(providerId, agentId) {
  if (!agentId) throw new Error("agentId is required for a CRM connection");
  return `${providerId}#${agentId}`;
}

export function providerIdOf(key) {
  return String(key ?? "").split("#")[0];
}

export function agentIdOf(key) {
  const [, agentId] = String(key ?? "").split("#");
  return agentId || null;
}

export function isConnected(connection) {
  return connection?.connectionState === "connected";
}

// The customer's own board (lookups and the optional board sync) can be used
// only when it's switched on AND its field mapping has been checked against
// the live CRM. The auto-created calls board needs only isConnected.
export function isConnectionUsable(connection) {
  return connection?.connectionState === "connected" &&
    connection?.boardSyncEnabled !== false &&
    connection?.mappingStatus === "valid" &&
    Boolean(connection?.mapping);
}

export function isConnectionPaused(connection, nowMs) {
  return Number(connection?.pausedUntil) > nowMs;
}
