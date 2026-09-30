import { createHash, randomUUID } from "node:crypto";

import { buildCallActivity } from "./activity.mjs";
import { callsBoardIdsOf, callsRowIsCurrent, checkMapping, createCallsLog } from "./calls-log.mjs";
import { createRequeuer } from "./requeue.mjs";
import { callLink } from "./monday/calls-board.mjs";
import { deriveCallFacts, followUpText, localDatePlusDays, transcriptText } from "./facts.mjs";
import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { maskPhone } from "./phone.mjs";
import { connectionKeyFor, isConnectionPaused, isConnectionUsable, providerIdOf } from "./provider.mjs";
import { boardLinkKeyFor, linkKeyFor } from "./store.mjs";

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
export const ACCOUNT_INACTIVE_PAUSE_MS = 24 * 60 * 60 * 1000;
// How often the keeper re-checks a customer-board mapping against Monday.
export const MAPPING_RECHECK_MS = 60 * 60 * 1000;
// Failures fixed by repairing the mapping: replayed once it's valid again.
const MAPPING_FAILURE_CODES = new Set([CRM_ERROR.MAPPING_INVALID]);
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
  enqueue,
  now = Date.now,
  log = console,
}) {
  // Re-sends calls that failed for a reason that has since been fixed.
  const requeueFailed = createRequeuer({ store, enqueue, metrics, now });
  const callsLog = createCallsLog({ store, providers, appUrl, metrics, log, now });

  // Records the call's final sync status (plus any ids) on the call row.
  async function finish(call, status, fields = {}) {
    await store.updateCallSync(call.workspaceId, call.callId, {
      crmStatus: status,
      ...fields,
    });
  }

  // Gives up on a call: marks it failed with the error code, records it on
  // the connection for the card, and counts it. The keeper's outage replay
  // may retry outage-type failures later.
  async function failPermanently(call, connection, error) {
    const code = error instanceof CrmError ? error.code : "unexpected";
    await finish(call, "failed", { crmLastErrorCode: code, crmLastErrorAt: new Date(Number(now())).toISOString() });
    if (connection) {
      await store.recordSyncResult(call.workspaceId, connection.provider, { status: "failed", errorCode: code })
        .catch(() => {});
    }
    metrics?.count("SyncFailed", { Provider: providerIdOf(connection?.provider) || "unknown", Outcome: code });
    return { status: "failed", code };
  }

  // Syncs one finished call to Monday, the SQS worker's main job. Writes the
  // calls-board row first, then the customer's own board when that's switched
  // on. Safe to run twice: each destination keeps its own item id on the
  // call. verifyExisting checks the board by Call ID first (catch-up after
  // reconnect).
  async function syncCall({ workspaceId, callId, attempt = 1, finalAttempt = false, verifyExisting = false }) {
    const started = Number(now());
    const call = await store.getCall(workspaceId, callId);
    if (!call) return { status: "skipped", reason: "call_not_found" };
    // "Add Sample Calls" demo data never goes to a customer's CRM.
    if (call.demoSeed === true) return { status: "skipped", reason: "sample_call" };
    if (call.crmStatus === "synced") {
      metrics?.count("SyncDuplicate", { Provider: providerIdOf(call.crmProvider) || "unknown" });
      return { status: "duplicate" };
    }

    const connectionKey = connectionKeyOfCall(call);
    const providerId = providerIdOf(connectionKey ?? call.crmProvider ?? "monday");
    const connection = connectionKey ? await store.getConnection(workspaceId, connectionKey) : null;
    if (!connection || connection.connectionState === "disconnected") {
      await finish(call, "skipped", { crmLastErrorCode: CRM_ERROR.NOT_CONNECTED });
      return { status: "skipped", reason: CRM_ERROR.NOT_CONNECTED };
    }
    if (connection.connectionState === "reauth_required") {
      return failPermanently(call, connection, new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Reconnect Monday"));
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
    facts.companyName = await store.getContactCompany?.(workspaceId, facts.phoneE164).catch(() => null) ?? null;

    // 1. The auto-created calls board: one row per call, written once per
    // board (a deleted board holds the call until an admin recreates it).
    if (!callsRowIsCurrent(call, connection)) {
      try {
        const result = await sessions.withSession(connection, (session) =>
          callsLog.logCall(session, connection, call, facts, {
            idempotencyKey: `${idempotencyBaseFor(workspaceId, callId)}-calls`,
            verifyExisting,
          })
        );
        if (result.status === "written") {
          call.crmCallsItemId = result.itemId;
          await store.updateCallSync(workspaceId, callId, {
            crmCallsItemId: result.itemId,
            crmCallsBoardId: result.boardId,
            crmProvider: connectionKey,
          });
        }
      } catch (error) {
        log.warn?.("CRM calls board write failed", { workspaceId, callId, attempt, ...describeError(error) });
        return handleFailure({ error, call, connection, finalAttempt });
      }
    }

    // 2. The customer's own board, only when that sync is switched on.
    if (connection.boardSyncEnabled === false || !connection.mapping) {
      await finish(call, "synced", {
        crmProvider: connectionKey,
        crmSyncedAt: new Date(Number(now())).toISOString(),
        crmLastErrorCode: null,
        crmLastErrorAt: null,
      });
      await store.recordSyncResult(workspaceId, connectionKey, { status: "synced" }).catch(() => {});
      metrics?.count("SyncSucceeded", { Provider: providerId, Outcome: "calls_board" });
      return { status: "synced", callsItemId: call.crmCallsItemId ?? null };
    }
    if (!isConnectionUsable(connection)) {
      return failPermanently(call, connection, new CrmError(CRM_ERROR.MAPPING_INVALID, "Field mapping needs attention"));
    }

    // Locked per board + caller, so agents sharing a board take turns on the
    // same caller (see boardLinkKeyFor).
    const boardId = connection.mapping?.boardId ?? null;
    const linkKey = boardId ? boardLinkKeyFor(connectionKey, boardId, facts.phoneE164) : linkKeyFor(connectionKey, facts.phoneE164);
    // Unique per attempt, not per call: two deliveries of the same message
    // must serialize too, not share the lease.
    const leaseOwner = `${callId}:${randomUUID()}`;
    const lease = await store.acquireLinkLease(workspaceId, linkKey, leaseOwner, Number(now()) + LEASE_MS);
    if (!lease) {
      metrics?.count("LeaseBusy", { Provider: providerId });
      throw new CrmError(CRM_ERROR.LEASE_BUSY, "Another sync for this number is running", {
        retryAfterSeconds: 30,
      });
    }

    try {
      await store.updateCallSync(workspaceId, callId, {
        crmStatus: "in_progress",
        crmProvider: connectionKey,
        crmAttempts: attempt,
      });
      // Links saved before they were per board live under the agent's key:
      // read that once, so a known caller isn't searched for or recreated.
      const link = lease.state || !boardId ? lease : {
        ...(await store.getLink(workspaceId, linkKeyFor(connectionKey, facts.phoneE164)).catch(() => null) ?? {}),
        ...lease,
      };
      const result = await sessions.withSession(connection, (session) =>
        runSync({ session, provider, call, facts, link, linkKey, connection })
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
      await store.recordSyncResult(workspaceId, connectionKey, { status: "synced" }).catch(() => {});
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
      await store.releaseLinkLease(workspaceId, linkKey, leaseOwner).catch(() => {});
    }
  }

  // Decides what a failed sync attempt means: retry (SQS redelivers), pause
  // the connection (rate or daily limits), mark reconnect-needed, or fail
  // permanently on the last attempt.
  async function handleFailure({ error, call, connection, finalAttempt }) {
    const { workspaceId, callId } = call;
    if (!(error instanceof CrmError)) {
      if (finalAttempt) {
        await failPermanently(call, connection, error);
      } else {
        await store.updateCallSync(workspaceId, callId, {
          crmStatus: "retrying",
          crmLastErrorCode: "unexpected",
          crmLastErrorAt: new Date(Number(now())).toISOString(),
        }).catch(() => {});
        metrics?.count("SyncRetried", { Provider: providerIdOf(connection.provider), Outcome: "unexpected" });
      }
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
      case CRM_ERROR.AMBIGUOUS_MATCH:
        return failPermanently(call, connection, error);
      case CRM_ERROR.DAILY_LIMIT: {
        const resetAt = nextUtcMidnight(Number(now()));
        await store.pause(workspaceId, connection.provider, resetAt, "daily_limit").catch(() => {});
        metrics?.count("RateLimited", { Provider: providerIdOf(connection.provider), Outcome: "daily_limit" });
        error.retryAfterSeconds = Math.ceil((resetAt - Number(now())) / 1000);
        break;
      }
      case CRM_ERROR.ACCOUNT_INACTIVE: {
        // Calls are still answered; logging waits a day at a time until the
        // Monday account is active again, then catches up.
        const resumeAt = Number(now()) + ACCOUNT_INACTIVE_PAUSE_MS;
        await store.pause(workspaceId, connection.provider, resumeAt, "account_inactive").catch(() => {});
        metrics?.count("AccountInactive", { Provider: providerIdOf(connection.provider) });
        error.retryAfterSeconds = Math.ceil(ACCOUNT_INACTIVE_PAUSE_MS / 1000);
        break;
      }
      case CRM_ERROR.RATE_LIMITED:
        metrics?.count("RateLimited", { Provider: providerIdOf(connection.provider), Outcome: "rate_limited" });
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
      metrics?.count("SyncFailed", { Provider: providerIdOf(connection.provider), Outcome: `exhausted_${error.code}` });
      await store.recordSyncResult(workspaceId, connection.provider, { status: "failed", errorCode: error.code })
        .catch(() => {});
    } else {
      metrics?.count("SyncRetried", { Provider: providerIdOf(connection.provider), Outcome: error.code });
    }
    throw error;
  }

  // The customer's own board: find the caller's row (by the saved link, then
  // phone, then email), create a lead if there is none, then log this call on
  // it. Idempotency keys stop duplicates when Monday times out after writing.
  async function runSync({ session, provider, call, facts, link, linkKey, connection }) {
    const { workspaceId, callId } = call;
    const boardKey = connection.mapping?.boardId ?? null;
    // Stable per call and bounded in length (Monday documents no key limit).
    const idempotencyBase = idempotencyBaseFor(workspaceId, callId);

    // 1. Which CRM record is this caller?
    let externalId = call.crmItemId ?? null;
    let url = call.crmItemUrl;
    let created = call.crmCreated === true;
    const linkUsable = link.boardId === boardKey;
    if (!externalId && linkUsable && link.state === "linked" && link.externalId) {
      externalId = link.externalId;
    }

    // Look the caller up in Monday. A recent "not found" for this number is
    // trusted for a while to save API calls; several matches is an error the
    // admin must fix (we never guess).
    const resolve = async () => {
      const recentlyNotFound = linkUsable && link.state === "none" &&
        Number(now()) - Date.parse(link.checkedAt ?? 0) < NEGATIVE_LOOKUP_TTL_MS;
      let found = null;
      if (!recentlyNotFound) found = await provider.findContactByPhone(session, facts.phoneE164);
      if (!found && facts.email) found = await provider.findContactByEmail(session, facts.email);
      if (found) {
        if (found.matchCount > 1) {
          metrics?.count("AmbiguousMatch", { Provider: provider.id });
          throw new CrmError(
            CRM_ERROR.AMBIGUOUS_MATCH,
            "Multiple CRM records match this caller",
          );
        }
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
        fields: { ...fieldPatch(facts, { isNew: true, call, appUrl }), assignDefaultOwner: true, source: LEAD_SOURCE },
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
    const fields = applyFields ? fieldPatch(facts, { isNew: false, link, call, appUrl }) : undefined;
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
          fields: created ? undefined : fieldPatch(facts, { isNew: false, link, call, appUrl }),
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

  // A follow-up added or changed in Symantic after the call synced. Best
  // effort: only the mapped Follow-Up column, on the row the call went to.
  async function syncFollowUp({ workspaceId, callId }) {
    const call = await store.getCall(workspaceId, callId);
    if (call?.crmStatus !== "synced" || (!call.crmItemId && !call.crmCallsItemId)) {
      return { status: "skipped", reason: "not_synced" };
    }
    const connectionKey = connectionKeyOfCall(call);
    const providerId = providerIdOf(connectionKey ?? "monday");
    const connection = connectionKey ? await store.getConnection(workspaceId, connectionKey) : null;
    if (connection?.connectionState !== "connected") return { status: "skipped", reason: "not_connected" };
    const provider = providers.get(providerId);
    const userBoard = Boolean(call.crmItemId && isConnectionUsable(connection) &&
      connection.mapping?.columns?.followUp?.id && provider?.updateFields);
    const callsBoard = Boolean(call.crmCallsItemId && connection.callsBoard?.status === "active" &&
      connection.callsBoard.columns?.followUp);
    if (!userBoard && !callsBoard) return { status: "skipped", reason: "no_follow_up_column" };
    try {
      await sessions.withSession(connection, async (session) => {
        if (callsBoard) await callsLog.updateFollowUp(session, connection, call);
        if (userBoard) await provider.updateFields(session, call.crmItemId, { followUp: followUpText(call.followUp) });
      });
      metrics?.count("FollowUpSynced", { Provider: providerId });
      return { status: "synced", callsBoard, userBoard };
    } catch (error) {
      log.warn?.("CRM follow-up not synced", { workspaceId, callId, ...describeError(error) });
      return { status: "failed", code: error instanceof CrmError ? error.code : "unexpected" };
    }
  }

  // Queued right after an agent connects: build its calls board with the
  // worker's longer time budget. Refusals are recorded on the connection by
  // ensureBoard; outages throw so SQS retries.
  // Queued right after an agent connects (and by Recreate Board / turning
  // the calls board back on): build its calls board with the worker's longer
  // time budget. `recreate` replaces a board deleted in Monday; `rebuild`
  // then queues every past call that isn't on the board yet. Refusals are
  // recorded on the connection; outages throw so SQS retries.
  async function ensureCallsBoard({ workspaceId, provider: connectionKey, recreate = false, rebuild = false }) {
    const connection = await store.getConnection(workspaceId, connectionKey);
    if (connection?.connectionState !== "connected") return { status: "skipped", reason: "not_connected" };
    if (connection.callsBoardEnabled === false) return { status: "skipped", reason: "off" };
    if (connection.callsBoard?.status === "deleted" && !recreate) return { status: "skipped", reason: "deleted" };
    try {
      await sessions.withSession(connection, (session) => callsLog.ensureBoard(session, connection, { recreate }));
    } catch (error) {
      if (error instanceof CrmError && !error.retryable) return { status: "refused", code: error.code };
      throw error;
    }
    const queued = rebuild ? await rebuildCallsBoard({ workspaceId, provider: connectionKey }) : 0;
    return { status: "ready", queued };
  }

  // Calls that belong on the calls board: real, analyzed calls with a caller
  // number (spam, test/sample and anonymous calls are never logged).
  function belongsOnCallsBoard(call) {
    return Boolean(call.callerNumber) && call.demoSeed !== true && call.outcome !== "spam" && Boolean(call.analyzedAt);
  }

  // Full history onto the agent's current calls board: queue a row write for
  // every eligible call whose row isn't on this board. Each write first
  // looks the call up by Call ID, so running this twice adds nothing.
  async function rebuildCallsBoard({ workspaceId, provider: connectionKey }) {
    const connection = await store.getConnection(workspaceId, connectionKey);
    if (!connection?.agentId || connection.callsBoard?.status !== "active" || !enqueue) return 0;
    const calls = await store.listAgentCalls(workspaceId, connection.agentId);
    let queued = 0;
    for (const call of calls) {
      if (!belongsOnCallsBoard(call) || callsRowIsCurrent(call, connection)) continue;
      await enqueue({ kind: "calls-board-row", workspaceId, callId: call.callId, provider: connectionKey });
      queued += 1;
    }
    metrics?.emit("CallsBoardRebuild", queued, { Provider: providerIdOf(connectionKey) });
    log.info?.("Calls board rebuild queued", { workspaceId, queued });
    return queued;
  }

  // One call's row on the calls board only (rebuilds): never touches the
  // customer's own board or the call's sync status.
  async function syncCallsBoardRow({ workspaceId, callId, provider: connectionKey }) {
    const [call, connection] = await Promise.all([
      store.getCall(workspaceId, callId),
      store.getConnection(workspaceId, connectionKey),
    ]);
    if (!call || connection?.connectionState !== "connected" || callsRowIsCurrent(call, connection)) return { status: "skipped" };
    const timezone = await store.getProfileTimezone(workspaceId).catch(() => null);
    const facts = deriveCallFacts(call, { timezone });
    if (!facts.phoneE164) return { status: "skipped" };
    facts.companyName = await store.getContactCompany?.(workspaceId, facts.phoneE164).catch(() => null) ?? null;
    const result = await sessions.withSession(connection, (session) =>
      callsLog.logCall(session, connection, call, facts, {
        idempotencyKey: `${idempotencyBaseFor(workspaceId, callId)}-calls`,
        verifyExisting: true,
      })
    );
    if (result.status === "written") {
      await store.updateCallSync(workspaceId, callId, { crmCallsItemId: result.itemId, crmCallsBoardId: result.boardId });
    }
    return result;
  }

  // After a reconnect with the board still there: send only what's missing -
  // calls taken while disconnected (never queued) and ones that failed.
  // Each is checked by Call ID first, so nothing already on the board is
  // added again.
  async function catchUpAfterReconnect({ workspaceId, provider: connectionKey, since }) {
    const connection = await store.getConnection(workspaceId, connectionKey);
    if (!connection?.agentId || connection.connectionState !== "connected" || !enqueue) return 0;
    const calls = await store.listAgentCalls(workspaceId, connection.agentId, { since });
    let queued = 0;
    for (const call of calls) {
      if (!belongsOnCallsBoard(call)) continue;
      if (call.crmStatus && call.crmStatus !== "failed") continue;
      if (!await store.markCallQueued(workspaceId, call.callId, connectionKey)) continue;
      await enqueue({ workspaceId, callId: call.callId, provider: connectionKey, verifyExisting: true });
      queued += 1;
    }
    log.info?.("Reconnect catch-up queued", { workspaceId, queued });
    return queued;
  }

  // One-time repair: point this call's "Listen" link (calls board and, when
  // mapped, the customer's Audio Link column) at Call History.
  async function rewriteCallLinks({ workspaceId, callId, provider: connectionKey }) {
    const [call, connection] = await Promise.all([
      store.getCall(workspaceId, callId),
      store.getConnection(workspaceId, connectionKey),
    ]);
    if (!call || connection?.connectionState !== "connected" || !appUrl) return { status: "skipped" };
    const provider = providers.get(connectionKey);
    const url = callLink(appUrl, callId);
    let updated = 0;
    await sessions.withSession(connection, async (session) => {
      const board = connection.callsBoard;
      if (board?.status === "active" && board.columns?.recording && callsRowIsCurrent(call, connection) && provider.updateCallsRow) {
        await provider.updateCallsRow(session, board.id, call.crmCallsItemId, { [board.columns.recording]: { url, text: "Listen" } });
        updated += 1;
      }
      if (call.crmItemId && isConnectionUsable(connection) && connection.mapping?.columns?.audioLink?.id && provider.updateFields) {
        await provider.updateFields(session, call.crmItemId, { audioLink: url });
        updated += 1;
      }
    });
    return { status: "done", updated };
  }

  // The keeper's 10-minute check of an agent's calls board. A board back
  // from Monday's trash gets every call it missed meanwhile.
  // The keeper's 10-minute check for one connection: is the calls board still
  // there (or back from Monday's trash), and - hourly - does the customer's
  // own board mapping still match Monday.
  async function checkCallsBoard(connection) {
    const result = await sessions.withSession(connection, (session) => callsLog.checkBoard(session, connection));
    if (result === "restored") await rebuildCallsBoard({ workspaceId: connection.workspaceId, provider: connection.provider });
    await recheckMapping(connection).catch((error) => {
      log.warn?.("CRM mapping re-check failed", { workspaceId: connection.workspaceId, ...describeError(error) });
    });
    return result;
  }

  // A column deleted or retyped in Monday (or the whole board deleted) is
  // flagged within the hour, even with no calls coming in: the card shows
  // what to fix, and the keeper's reminders email the admins once. When a
  // fix made in Monday (e.g. restoring the column) makes it valid again,
  // calls that failed because of it are sent again.
  async function recheckMapping(connection) {
    if (connection.boardSyncEnabled === false || !connection.mapping) return null;
    if (Number(now()) - Date.parse(connection.mappingCheckedAt ?? 0) < MAPPING_RECHECK_MS) return null;
    const provider = providers.get(connection.provider);
    if (!provider?.validateMapping) return null;
    const ours = await callsBoardIdsOf(store, connection.workspaceId);
    const outcome = await sessions.withSession(connection, (session) => checkMapping(provider, session, connection.mapping, ours));
    const status = outcome.ok ? "valid" : "invalid";
    const wasValid = connection.mappingStatus === "valid";
    await store.saveMapping(connection.workspaceId, connection.provider, connection.mapping, { status, problems: outcome.problems });
    connection.mappingStatus = status;
    connection.mappingProblems = outcome.problems;
    if (status === "valid" && !wasValid) {
      await requeueFailed(connection.workspaceId, connection.provider, { onlyCodes: MAPPING_FAILURE_CODES });
    }
    return status;
  }

  return { syncCall, syncFollowUp, ensureCallsBoard, checkCallsBoard, rebuildCallsBoard, syncCallsBoardRow, catchUpAfterReconnect, rewriteCallLinks };
}

// Stable per call and bounded in length (Monday documents no key limit).
function idempotencyBaseFor(workspaceId, callId) {
  return `sym-${createHash("sha256").update(`${workspaceId}\0${callId}`).digest("hex").slice(0, 32)}`;
}

// The connection a call syncs through: its agent's. Calls queued before
// connections were per agent carry the bare provider id.
export function connectionKeyOfCall(call) {
  const recorded = String(call?.crmProvider ?? "");
  if (recorded.includes("#")) return recorded;
  return call?.agentId ? connectionKeyFor(recorded || "monday", call.agentId) : null;
}

// True when this call is the newest one applied to the caller's row, so an
// older call replayed late never overwrites newer fields.
function isNewest(facts, link, linkUsable) {
  if (!facts.endedAt) return false;
  if (!linkUsable || !link.lastAppliedEndedAt) return true;
  return facts.endedAt >= link.lastAppliedEndedAt;
}

// Fields we own on the CRM record. Status is only ever set on creation, or
// to "follow up" when this call needs one; the owner only on creation.
function fieldPatch(facts, { isNew, link, call, appUrl }) {
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
    if (!isNew && appointment.startTimeUtc && link?.appointmentAt === appointment.startTimeUtc) {
      patch.nextAppointmentAt = null;
    }
  } else if (appointment?.startTimeUtc) {
    patch.nextAppointmentAt = appointment.startTimeUtc;
  }
  if (facts.summary) patch.transcriptSummary = facts.summary;
  const transcript = transcriptText(call?.transcript);
  if (transcript) patch.fullTranscript = transcript;
  if (facts.companyName) patch.companyName = facts.companyName;
  if (typeof call?.userSentiment === "string" && call.userSentiment.trim()) patch.sentiment = call.userSentiment.trim();
  const followUp = followUpText(call?.followUp);
  if (followUp) patch.followUp = followUp;
  if (appUrl && facts.callId) patch.audioLink = callLink(appUrl, facts.callId);
  if (facts.durationMs != null) patch.callDuration = Math.round(facts.durationMs / 60000);
  if (facts.name) patch.callerName = facts.name;
  if (facts.startedAt) {
    patch.date = facts.startedAt;
    patch.time = facts.startedAt;
  }
  if (facts.intent) patch.intent = facts.intent;
  patch.direction = "Inbound";
  if (facts.appointment) patch.appointment = facts.appointment.kind === "booked" || facts.appointment.kind === "rescheduled";
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

// When Monday's daily API limit resets (just after 00:00 UTC); the connection
// is paused until then.
function nextUtcMidnight(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 5);
}
