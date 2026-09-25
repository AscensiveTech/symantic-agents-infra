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
    get(id) {
      return byId.get(id) ?? null;
    },
    ids() {
      return [...byId.keys()];
    },
  };
}

// A connection can be used for lookups and syncs only when it is authorized
// AND its field mapping has been checked against the live CRM.
export function isConnectionUsable(connection) {
  return connection?.connectionState === "connected" &&
    connection?.mappingStatus === "valid" &&
    Boolean(connection?.mapping);
}

export function isConnectionPaused(connection, nowMs) {
  return Number(connection?.pausedUntil) > nowMs;
}
