import { buildCallerContext, NO_CRM_CONTEXT } from "./context.mjs";
import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { maskPhone, toE164 } from "./phone.mjs";
import { isConnectionPaused, isConnectionUsable } from "./provider.mjs";
import { linkKeyFor } from "./store.mjs";

// Monday calls inside the lookup get this long each. The BFF separately caps
// the whole lookup (including Lambda invoke) - see handleInboundLookup.
const LOOKUP_REQUEST_TIMEOUT_MS = 1_100;

/**
 * Call-time caller lookup. Runs while the caller hears ringing, so it never
 * throws and never waits on anything it can skip: every failure path
 * returns "no context" and the call proceeds exactly as it would without a
 * CRM. Cost: one Monday request (fetch-by-id for a known caller, one search
 * otherwise).
 */
export function createCrmLookup({
  store,
  providers,
  sessions,
  metrics,
  now = Date.now,
  log = console,
}) {
  return async function lookup({ workspaceId, callerNumber, provider: providerId = "monday" }) {
    const started = Number(now());
    const result = (status, extra = {}) => {
      metrics?.emit("LookupLatency", Number(now()) - started, { Provider: providerId, Outcome: status });
      metrics?.count("Lookup", { Provider: providerId, Outcome: status });
      return { status, context: NO_CRM_CONTEXT, ...extra };
    };

    const phoneE164 = toE164(callerNumber ?? "", "US");
    if (!workspaceId || !phoneE164) return result("skipped", { reason: "no_caller_number" });

    try {
      const connection = await store.getConnection(workspaceId, providerId);
      if (!isConnectionUsable(connection)) return result("skipped", { reason: "not_connected" });
      if (isConnectionPaused(connection, Number(now()))) return result("skipped", { reason: "paused" });
      const provider = providers.get(providerId);
      if (!provider) return result("skipped", { reason: "unknown_provider" });

      const linkKey = linkKeyFor(providerId, phoneE164);
      const boardId = connection.mapping?.boardId ?? null;
      const link = await store.getLink(workspaceId, linkKey);
      const knownId = link?.state === "linked" && link.boardId === boardId ? link.externalId : null;

      // No refresh-lock waiting on the live path: if another container is
      // mid-refresh and our token is expired, skip rather than hold the ring.
      const contact = await sessions.withSession(connection, async (session) => {
        const timed = { ...session, timeoutMs: LOOKUP_REQUEST_TIMEOUT_MS };
        if (knownId) {
          const byId = await provider.getContact(timed, knownId);
          if (byId) return byId;
        }
        return provider.findContactByPhone(timed, phoneE164);
      }, { waitMs: 0 });

      // Remember the answer for the post-call sync (saves it a search). A
      // write failure here must not cost the caller anything.
      const checkedAt = new Date(Number(now())).toISOString();
      const linkWrite = contact
        ? (contact.externalId !== knownId
          ? store.saveLink(workspaceId, linkKey, {
            provider: providerId,
            phoneE164,
            state: "linked",
            externalId: contact.externalId,
            boardId,
            checkedAt,
          })
          : null)
        : (link?.state !== "creating"
          ? store.saveLink(workspaceId, linkKey, {
            provider: providerId,
            phoneE164,
            state: "none",
            externalId: null,
            boardId,
            checkedAt,
          })
          : null);
      await linkWrite?.catch((error) => {
        log.warn?.("CRM link write failed", { workspaceId, name: error?.name });
      });

      if (!contact) return result("not_found");
      return result("found", {
        context: buildCallerContext(contact),
        contact: { name: contact.name, status: contact.status, ownerName: contact.ownerName },
      });
    } catch (error) {
      const info = describeError(error);
      if (error instanceof CrmError && error.code === CRM_ERROR.DAILY_LIMIT) {
        await store.pause(workspaceId, providerId, nextUtcMidnight(Number(now())), "daily_limit").catch(() => {});
      }
      log.warn?.("CRM lookup failed; call continues without CRM context", {
        workspaceId,
        caller: maskPhone(phoneE164),
        ...info,
      });
      const status = info.code === CRM_ERROR.TIMEOUT ? "timeout" : "error";
      return result(status, { reason: info.code });
    }
  };
}

function nextUtcMidnight(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 5);
}
