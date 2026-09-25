import { createHash } from "node:crypto";

import { buildCallActivity } from "./activity.mjs";
import { deriveCallFacts, localDatePlusDays } from "./facts.mjs";
import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { maskPhone } from "./phone.mjs";
import { isConnectionPaused, isConnectionUsable } from "./provider.mjs";
import { linkKeyFor } from "./store.mjs";

// Longer than the worker's 60s timeout, so a lease never expires under a
// sync that is still running.
const LEASE_MS = 120_000;
// Monday replays a mutation with the same Idempotency-Key for 30 minutes.
// Inside that window a retry is protected by the provider; outside it we
// check the record for our own note before posting again.
const PROVIDER_IDEMPOTENCY_WINDOW_MS = 25 * 60 * 1000;
// A "no CRM record" answer from the call-time lookup is trusted this long,
// saving a second search for a brand-new caller.
const NEGATIVE_LOOKUP_TTL_MS = 15 * 60 * 1000;
const FOLLOW_UP_DAYS = 1;
const LEAD_SOURCE = "AI Receptionist";

/**
 * Post-call CRM synchronization for one call. Safe to run any number of
 * times for the same call, concurrently or out of order:
 *  - one record per phone number: a per-phone lease plus search-before-create
 *  - one note per call: provider idempotency keys, then a Ref: check
 *  - no field regressions: fields are written only by the newest call
 *    (per-phone watermark on lastAppliedEndedAt)
 *
 * Throws a retryable CrmError for the worker to back off on; returns a
 * result for everything that is final (synced, skipped, or failed for a
 * reason a retry cannot fix).
 */
export function createCrmSync({
  store,
  providers,
  sessions,
  appUrl,
  metrics,
  now = Date.now,
  log = console,
}) {
  async function finish(call, status, fields = {}) {
    await store.updateCallSync(call.workspaceId, call.callId, {
      crmStatus: status,
      ...fields,
    });
  }

  async function failPermanently(call, connection, error) {
    const code = error instanceof CrmError ? error.code : "unexpected";
    await finish(call, "failed", { crmLastErrorCode: code, crmLastErrorAt: new Date(Number(now())).toISOString() });
    if (connection) {
      await store.recordSyncResult(call.workspaceId, connection.provider, { status: "failed", errorCode: code })
        .catch(() => {});
    }
    metrics?.count("SyncFailed", { Provider: connection?.provider ?? "unknown", Outcome: code });
    return { status: "failed", code };
  }

  async function syncCall({ workspaceId, callId, attempt = 1, finalAttempt = false }) {
    const started = Number(now());
    const call = await store.getCall(workspaceId, callId);
    if (!call) return { status: "skipped", reason: "call_not_found" };
    if (call.crmStatus === "synced") {
      metrics?.count("SyncDuplicate", { Provider: call.crmProvider ?? "unknown" });
      return { status: "duplicate" };
    }

    const providerId = call.crmProvider ?? "monday";
    const connection = await store.getConnection(workspaceId, providerId);
    if (!connection || connection.connectionState === "disconnected") {
      await finish(call, "skipped", { crmLastErrorCode: CRM_ERROR.NOT_CONNECTED });
      return { status: "skipped", reason: CRM_ERROR.NOT_CONNECTED };
    }
    if (connection.connectionState === "reauth_required") {
      return failPermanently(call, connection, new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Reconnect Monday"));
    }
    if (!isConnectionUsable(connection)) {
      return failPermanently(call, connection, new CrmError(CRM_ERROR.MAPPING_INVALID, "Field mapping needs attention"));
    }
    if (isConnectionPaused(connection, Number(now()))) {
      throw new CrmError(CRM_ERROR.DAILY_LIMIT, "CRM sync is paused", {
        retryAfterSeconds: Math.ceil((Number(connection.pausedUntil) - Number(now())) / 1000),
      });
    }
    const provider = providers.get(providerId);
    if (!provider) return failPermanently(call, connection, new CrmError(CRM_ERROR.NOT_CONNECTED, "Unknown CRM"));

    const timezone = await store.getProfileTimezone(workspaceId).catch(() => null);
    const facts = deriveCallFacts(call, { timezone });
    if (facts.skipReason || !facts.phoneE164) {
      const reason = facts.skipReason ?? "no_caller_number";
      await finish(call, "skipped", { crmLastErrorCode: reason });
      return { status: "skipped", reason };
    }

    const linkKey = linkKeyFor(providerId, facts.phoneE164);
    const lease = await store.acquireLinkLease(workspaceId, linkKey, callId, Number(now()) + LEASE_MS);
    if (!lease) {
      metrics?.count("LeaseBusy", { Provider: providerId });
      throw new CrmError(CRM_ERROR.LEASE_BUSY, "Another call from this number is syncing", {
        retryAfterSeconds: 15,
      });
    }

    await store.updateCallSync(workspaceId, callId, {
      crmStatus: "in_progress",
      crmProvider: providerId,
      crmAttempts: attempt,
    });

    try {
      const result = await sessions.withSession(connection, (session) =>
        runSync({ session, provider, call, facts, link: lease, linkKey, connection })
      );
      await finish(call, "synced", {
        crmItemId: result.externalId,
        crmItemUrl: result.url,
        crmActivityId: result.activityId,
        crmCreated: result.created,
        crmSyncedAt: new Date(Number(now())).toISOString(),
        crmLastErrorCode: null,
        crmLastErrorAt: null,
      });
      await store.recordSyncResult(workspaceId, providerId, { status: "synced" }).catch(() => {});
      metrics?.count("SyncSucceeded", { Provider: providerId, Outcome: result.created ? "created" : "updated" });
      metrics?.emit("SyncDuration", Number(now()) - started, { Provider: providerId });
      log.info?.("CRM sync complete", {
        workspaceId,
        callId,
        provider: providerId,
        caller: maskPhone(facts.phoneE164),
        created: result.created,
        fieldsApplied: result.fieldsApplied,
      });
      return { status: "synced", ...result };
    } catch (error) {
      log.warn?.("CRM sync attempt failed", {
        workspaceId,
        callId,
        provider: providerId,
        attempt,
        ...describeError(error),
      });
      return handleFailure({ error, call, connection, finalAttempt });
    } finally {
      await store.releaseLinkLease(workspaceId, linkKey, callId).catch(() => {});
    }
  }

  async function handleFailure({ error, call, connection, finalAttempt }) {
    const { workspaceId, callId } = call;
    if (!(error instanceof CrmError)) {
      if (finalAttempt) await failPermanently(call, connection, error);
      throw error;
    }
    switch (error.code) {
      case CRM_ERROR.REAUTH_REQUIRED:
      case CRM_ERROR.NOT_CONNECTED:
      case CRM_ERROR.FORBIDDEN:
        if (error.code === CRM_ERROR.FORBIDDEN) {
          await store.markMappingInvalid(workspaceId, connection.provider, [{
            field: "board",
            code: "forbidden",
            message: "The connected account can no longer write to this board.",
          }]).catch(() => {});
        }
        return failPermanently(call, connection, error);
      case CRM_ERROR.MAPPING_INVALID:
        await store.markMappingInvalid(workspaceId, connection.provider, [{
          field: error.resource === "board" ? "board" : error.resource === "owner" ? "defaultOwnerId" : "columns",
          code: "rejected",
          message: error.resource === "board"
            ? "Monday no longer recognises the mapped board."
            : error.resource === "owner"
              ? "Monday no longer recognises the default owner."
              : "Monday rejected one of the mapped columns.",
        }]).catch(() => {});
        return failPermanently(call, connection, error);
      case CRM_ERROR.INVALID_VALUE:
        return failPermanently(call, connection, error);
      case CRM_ERROR.DAILY_LIMIT: {
        const resetAt = nextUtcMidnight(Number(now()));
        await store.pause(workspaceId, connection.provider, resetAt, "daily_limit").catch(() => {});
        metrics?.count("RateLimited", { Provider: connection.provider, Outcome: "daily_limit" });
        error.retryAfterSeconds = Math.ceil((resetAt - Number(now())) / 1000);
        break;
      }
      case CRM_ERROR.RATE_LIMITED:
        metrics?.count("RateLimited", { Provider: connection.provider, Outcome: "rate_limited" });
        break;
      default:
        break;
    }
    await store.updateCallSync(workspaceId, callId, {
      crmStatus: finalAttempt ? "failed" : "retrying",
      crmLastErrorCode: error.code,
      crmLastErrorAt: new Date(Number(now())).toISOString(),
    }).catch(() => {});
    if (finalAttempt) {
      metrics?.count("SyncFailed", { Provider: connection.provider, Outcome: `exhausted_${error.code}` });
      await store.recordSyncResult(workspaceId, connection.provider, { status: "failed", errorCode: error.code })
        .catch(() => {});
    } else {
      metrics?.count("SyncRetried", { Provider: connection.provider, Outcome: error.code });
    }
    throw error;
  }

  async function runSync({ session, provider, call, facts, link, linkKey, connection }) {
    const { workspaceId, callId } = call;
    const boardKey = connection.mapping?.boardId ?? null;
    // Stable per call and bounded in length (Monday documents no key limit).
    const idempotencyBase = `sym-${createHash("sha256").update(`${workspaceId}\0${callId}`).digest("hex").slice(0, 32)}`;

    // 1. Which CRM record is this caller?
    let externalId = call.crmItemId ?? null;
    let url = call.crmItemUrl;
    let created = call.crmCreated === true;
    const linkUsable = link.boardId === boardKey;
    if (!externalId && linkUsable && link.state === "linked" && link.externalId) {
      externalId = link.externalId;
    }

    const resolve = async () => {
      const recentlyNotFound = linkUsable && link.state === "none" &&
        Number(now()) - Date.parse(link.checkedAt ?? 0) < NEGATIVE_LOOKUP_TTL_MS;
      let found = null;
      if (!recentlyNotFound) found = await provider.findContactByPhone(session, facts.phoneE164);
      if (!found && facts.email) found = await provider.findContactByEmail(session, facts.email);
      if (found) {
        if (found.matchCount > 1) metrics?.count("AmbiguousMatch", { Provider: provider.id });
        await store.saveLink(workspaceId, linkKey, {
          provider: provider.id,
          phoneE164: facts.phoneE164,
          state: "linked",
          externalId: found.externalId,
          boardId: boardKey,
          checkedAt: new Date(Number(now())).toISOString(),
        });
        return { externalId: found.externalId, url: found.url, created: false };
      }
      // Mark the attempt before creating: if we crash after Monday creates
      // the record, the retry sees "creating" and searches instead of trusting
      // a stale "none".
      await store.saveLink(workspaceId, linkKey, {
        provider: provider.id,
        phoneE164: facts.phoneE164,
        state: "creating",
        boardId: boardKey,
        externalId: null,
      });
      const contact = await provider.createLead(session, {
        name: facts.name ?? `New caller ${facts.phoneE164}`,
        phoneE164: facts.phoneE164,
        email: facts.email ?? undefined,
        fields: { ...fieldPatch(facts, { isNew: true }), assignDefaultOwner: true, source: LEAD_SOURCE },
      }, { idempotencyKey: `${idempotencyBase}-create` });
      await store.saveLink(workspaceId, linkKey, {
        provider: provider.id,
        phoneE164: facts.phoneE164,
        state: "linked",
        externalId: contact.externalId,
        boardId: boardKey,
        checkedAt: new Date(Number(now())).toISOString(),
        createdByCallId: callId,
      });
      if (facts.endedAt) {
        await store.advanceWatermark(workspaceId, linkKey, facts.endedAt, appointmentMarker(facts, link)).catch(() => {});
      }
      return { externalId: contact.externalId, url: contact.url, created: true };
    };

    if (!externalId) {
      ({ externalId, url, created } = await resolve());
      await store.updateCallSync(workspaceId, callId, {
        crmItemId: externalId,
        crmItemUrl: url,
        crmCreated: created,
      });
    }

    // 2. The call note, exactly once.
    if (call.crmActivityId) {
      return { externalId, url, created, activityId: call.crmActivityId, fieldsApplied: false };
    }
    const activity = buildCallActivity(facts, { appUrl });
    const previousAttempt = Date.parse(call.crmActivityAttemptedAt ?? "");
    if (Number.isFinite(previousAttempt) && Number(now()) - previousAttempt > PROVIDER_IDEMPOTENCY_WINDOW_MS) {
      const existing = await provider.findActivityByRef(session, externalId, activity.ref);
      if (existing) {
        return { externalId, url, created, activityId: existing, fieldsApplied: false };
      }
    }

    const applyFields = !created && isNewest(facts, link, linkUsable);
    const fields = applyFields ? fieldPatch(facts, { isNew: false, link }) : undefined;
    await store.updateCallSync(workspaceId, callId, {
      crmActivityAttemptedAt: new Date(Number(now())).toISOString(),
    });

    let logged;
    try {
      logged = await provider.logCallActivity(session, externalId, activity, {
        fields,
        idempotencyKey: `${idempotencyBase}-note`,
      });
    } catch (error) {
      // The record was deleted in the CRM since we linked it: forget the link
      // and resolve again (find or create) once.
      if (error instanceof CrmError && error.code === CRM_ERROR.NOT_FOUND && !created) {
        metrics?.count("StaleLink", { Provider: provider.id });
        await store.saveLink(workspaceId, linkKey, { state: "none", externalId: null, boardId: boardKey, checkedAt: "1970-01-01T00:00:00.000Z" });
        link = { ...link, state: "none", checkedAt: "1970-01-01T00:00:00.000Z" };
        await store.updateCallSync(workspaceId, callId, { crmItemId: null, crmItemUrl: null, crmCreated: null });
        ({ externalId, url, created } = await resolve());
        await store.updateCallSync(workspaceId, callId, { crmItemId: externalId, crmItemUrl: url, crmCreated: created });
        logged = await provider.logCallActivity(session, externalId, activity, {
          fields: created ? undefined : fieldPatch(facts, { isNew: false, link }),
          idempotencyKey: `${idempotencyBase}-note-${externalId}`,
        });
      } else {
        throw error;
      }
    }
    await store.updateCallSync(workspaceId, callId, { crmActivityId: logged.activityId });

    if (logged.fieldsApplied && facts.endedAt) {
      await store.advanceWatermark(workspaceId, linkKey, facts.endedAt, appointmentMarker(facts, link)).catch(() => {});
    }
    if (logged.fieldsError) {
      // The note landed; the column write did not. Surface a mapping problem
      // to the admin, but the call itself is recorded in the CRM.
      log.warn?.("CRM fields not applied", { workspaceId, callId, ...describeError(logged.fieldsError) });
      if (logged.fieldsError.code === CRM_ERROR.MAPPING_INVALID) {
        await store.markMappingInvalid(workspaceId, connection.provider, [{
          field: "columns",
          code: "rejected",
          message: "Monday rejected one of the mapped columns.",
        }]).catch(() => {});
      }
    }
    return { externalId, url, created, activityId: logged.activityId, fieldsApplied: logged.fieldsApplied };
  }

  return { syncCall };
}

function isNewest(facts, link, linkUsable) {
  if (!facts.endedAt) return false;
  if (!linkUsable || !link.lastAppliedEndedAt) return true;
  return facts.endedAt >= link.lastAppliedEndedAt;
}

// Fields we own on the CRM record. Status is only ever set on creation, or
// to "follow up" when this call needs one; the owner only on creation.
function fieldPatch(facts, { isNew, link }) {
  const patch = {
    lastCallAt: facts.endedAt ?? undefined,
    outcome: facts.outcomeLabel,
  };
  if (isNew) patch.status = "new_lead";
  if (facts.followUpRequired) {
    patch.followUpDate = localDatePlusDays(facts.endedAt, facts.timezone, FOLLOW_UP_DAYS) ?? undefined;
    if (!isNew) patch.status = "follow_up";
  }
  const appointment = facts.appointment;
  if (appointment?.kind === "cancelled") {
    // Clear the date only if it is the one we wrote - never someone else's.
    if (!isNew && appointment.startTimeUtc && link?.appointmentAt === appointment.startTimeUtc) {
      patch.nextAppointmentAt = null;
    }
  } else if (appointment?.startTimeUtc) {
    patch.nextAppointmentAt = appointment.startTimeUtc;
  }
  return patch;
}

// Remembers which appointment date we last wrote, so a later cancellation
// clears only that one.
function appointmentMarker(facts, link) {
  const appointment = facts.appointment;
  if (!appointment?.startTimeUtc) return {};
  if (appointment.kind === "cancelled") {
    return link?.appointmentAt === appointment.startTimeUtc ? { appointmentAt: null } : {};
  }
  return { appointmentAt: appointment.startTimeUtc };
}

function nextUtcMidnight(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 5);
}
