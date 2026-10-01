// Two-way caller-name sync between Symantic and each agent's mapped Monday
// board. The Symantic AI Calls board is never involved: it's a per-call log,
// so renaming one of its rows renames a call, not a person.
//
//  - Monday -> Symantic: Monday webhooks on the mapped board, live.
//  - Symantic -> Monday: renaming a contact in Symantic renames that caller's
//    row on every connected agent's mapped board (once per board).
//  - Catch-up: whenever an agent's sync is (re)set up - first setup, a
//    reconnect or renewal, a board change, board sync turned back on - the
//    board's names and Symantic's are compared once, both ways, so changes
//    made while disconnected (on either side) aren't lost.
//  - Daily check: confirms the agent's webhooks still exist in Monday (and
//    that our background jobs weren't offline); if not, re-creates them and
//    catches up. No hourly polling.
//
// The newest change wins (contacts carry nameUpdatedAt), our own writes
// coming back from Monday are ignored, and a number Symantic has never heard
// from is never added to Contacts just because it's on a Monday board.

import { createHmac, timingSafeEqual } from "node:crypto";
import { describeError } from "./errors.mjs";
import { agentIdOf, isConnectionUsable } from "./provider.mjs";
import { boardLinkKeyFor, linkKeyFor } from "./store.mjs";

/** The OAuth scope Monday requires before an app may create webhooks. */
export const WEBHOOK_SCOPE = "webhooks:write";

const DAILY_CHECK_MS = 24 * 60 * 60 * 1000;
// Background jobs offline longer than this may have missed webhook deliveries.
const OUTAGE_GAP_MS = 60 * 60 * 1000;
const CATCH_UP_MAX_PAGES = 20; // 2,000 rows; a catch-up is rare
const NAME_MAX = 120;

/** True when the connection's grant lets us create webhooks. */
export function hasWebhookScope(connection) {
  return Array.isArray(connection?.scopes) && connection.scopes.includes(WEBHOOK_SCOPE);
}

/**
 * How names currently sync for a connection, for the Monday card:
 * "instant" (both ways, live), "renew" (Symantic -> Monday live, Monday ->
 * Symantic only at catch-ups until the connection is renewed with the
 * webhook permission) or "off" (no board sync).
 */
export function nameSyncMode(connection) {
  if (connection?.connectionState !== "connected" || connection.boardSyncEnabled === false || !connection.mapping) return "off";
  return connection.nameWebhooks?.ids?.length ? "instant" : "renew";
}

// Signature carried in each webhook URL: proves a delivery is for this
// workspace + agent without exposing anything secret.
export function webhookSignature(secret, workspaceId, agentId) {
  return createHmac("sha256", String(secret)).update(`${workspaceId}|${agentId}`).digest("base64url").slice(0, 32);
}

/** Constant-time check of a webhook URL's signature. */
export function verifyWebhookSignature(secret, workspaceId, agentId, signature) {
  if (!secret || typeof workspaceId !== "string" || typeof agentId !== "string" || typeof signature !== "string") return false;
  const expected = Buffer.from(webhookSignature(secret, workspaceId, agentId));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The new name in a Monday webhook event: an item rename carries it in
 * value.name, a text-column change in value.value (or value.text).
 */
export function nameFromWebhookEvent(event) {
  const value = event?.value;
  const raw = value?.name ?? value?.value ?? value?.text ?? (typeof value === "string" ? value : null);
  return typeof raw === "string" ? raw.trim().slice(0, NAME_MAX) : "";
}

export function createNameSync({ store, providers, sessions, apiBaseUrl, getAppSecret, enqueue, now = Date.now, log = console }) {
  const stamp = () => new Date(Number(now())).toISOString();

  // Where Monday delivers this agent's rename events.
  async function webhookUrl(connection) {
    const secret = await getAppSecret();
    const clientSecret = secret?.clientSecret ?? secret?.client_secret;
    const agentId = connection.agentId ?? agentIdOf(connection.provider);
    const url = new URL(`${String(apiBaseUrl).replace(/\/+$/, "")}/crm/monday/webhook`);
    url.searchParams.set("w", connection.workspaceId);
    url.searchParams.set("a", agentId);
    url.searchParams.set("s", webhookSignature(clientSecret, connection.workspaceId, agentId));
    return url.toString();
  }

  async function deleteAll(session, provider, connection) {
    for (const id of connection.nameWebhooks?.ids ?? []) {
      await provider.deleteWebhook?.(session, id).catch(() => {});
    }
  }

  /**
   * Makes this agent's webhooks match its current mapping: the old ones are
   * removed, and - when board sync is on and the grant allows webhooks - new
   * ones are created on the mapped board for row renames and for the mapped
   * Caller Name column. Run after a mapping save, the board-sync switch or a
   * reconnect.
   */
  async function registerWebhooks({ workspaceId, provider: key }) {
    const connection = await store.getConnection(workspaceId, key);
    const provider = providers.get(key);
    if (!connection || connection.connectionState !== "connected" || !provider?.createWebhook) return { status: "skipped" };
    return sessions.withSession(connection, async (session) => {
      await deleteAll(session, provider, connection);
      const wanted = connection.boardSyncEnabled !== false && connection.mapping?.boardId &&
        connection.mappingStatus === "valid" && hasWebhookScope(connection);
      const syncOn = connection.boardSyncEnabled !== false && connection.mapping?.boardId && connection.mappingStatus === "valid";
      if (!wanted) {
        if (connection.nameWebhooks) await store.saveNameWebhooks(workspaceId, key, null);
        // Even without webhooks, a (re)setup reconciles names once.
        if (syncOn) await enqueue({ kind: "name-catch-up", workspaceId, provider: key });
        return { status: syncOn ? "renew" : "off" };
      }
      const url = await webhookUrl(connection);
      const boardId = String(connection.mapping.boardId);
      const ids = [await provider.createWebhook(session, { boardId, url, event: "change_name" })];
      const column = connection.mapping.columns?.callerName?.id;
      if (column) ids.push(await provider.createWebhook(session, { boardId, url, event: "change_specific_column_value", config: { columnId: column } }));
      await store.saveNameWebhooks(workspaceId, key, { boardId, ids, createdAt: stamp() });
      log.info?.("Name-sync webhooks registered", { workspaceId, agentId: agentIdOf(key), count: ids.length });
      // Anything renamed on either side before now is reconciled once.
      await enqueue({ kind: "name-catch-up", workspaceId, provider: key });
      return { status: "instant", ids };
    });
  }

  /** Best effort, while the tokens still work (e.g. just before disconnecting). */
  async function removeWebhooks(connection) {
    if (!connection?.nameWebhooks?.ids?.length) return;
    const provider = providers.get(connection.provider);
    try {
      await sessions.withSession(connection, (session) => deleteAll(session, provider, connection));
    } catch (error) {
      log.warn?.("Name-sync webhooks not removed", { workspaceId: connection.workspaceId, ...describeError(error) });
    }
    await store.saveNameWebhooks(connection.workspaceId, connection.provider, null).catch(() => {});
  }

  /**
   * A row was renamed in Monday (webhook or catch-up): rename that caller
   * in Symantic - the contact and every one of their calls - unless the
   * change is our own write coming back, is older than the last rename, or
   * is for a number Symantic has never had a call from.
   */
  async function applyFromMonday({ workspaceId, provider: key, boardId, itemId, name, at, phoneE164 = null }) {
    const clean = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
    if (!clean) return { status: "skipped", reason: "empty" };
    const connection = await store.getConnection(workspaceId, key);
    if (!isConnectionUsable(connection) || String(connection.mapping.boardId) !== String(boardId)) {
      return { status: "skipped", reason: "not_mapped" };
    }
    let phone = phoneE164;
    if (!phone) {
      const provider = providers.get(key);
      const row = await sessions.withSession(connection, (session) => provider.getContact(session, String(itemId)));
      phone = row?.phoneE164 ?? null;
    }
    if (!phone) return { status: "skipped", reason: "no_phone" };
    const link = await store.getLink(workspaceId, boardLinkKeyFor(key, boardId, phone));
    if (link?.lastWrittenName === clean) return { status: "skipped", reason: "echo" };
    const contact = await store.getContactRecord(workspaceId, phone);
    if (contact?.name === clean) return { status: "skipped", reason: "same" };
    // Never add a number to Contacts just because it's on a Monday board.
    if (!contact && !(await store.countCallsForPhone(workspaceId, phone))) return { status: "skipped", reason: "unknown_caller" };
    const applied = await store.renameContactFromCrm(workspaceId, phone, clean, { at: at ?? stamp(), source: "monday" });
    if (!applied) return { status: "skipped", reason: "older" };
    const calls = await store.renameCallsForPhone(workspaceId, phone, clean);
    log.info?.("Caller renamed from Monday", { workspaceId, agentId: agentIdOf(key), calls });
    return { status: "renamed", calls };
  }

  /**
   * A contact was renamed in Symantic: rename that caller's row on every
   * connected agent's mapped board (each board once, even if several agents
   * share it). A caller who isn't on a board is left alone there.
   */
  async function pushToMonday({ workspaceId, phone, name }) {
    const clean = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
    if (!clean || !phone) return { status: "skipped", renamed: 0 };
    const connections = (await store.listWorkspaceConnections(workspaceId)).filter(isConnectionUsable);
    const boards = new Set();
    let renamed = 0;
    for (const connection of connections) {
      const boardId = String(connection.mapping.boardId);
      const provider = providers.get(connection.provider);
      if (boards.has(boardId) || !provider?.renameItem) continue;
      boards.add(boardId);
      const linkKey = boardLinkKeyFor(connection.provider, boardId, phone);
      const link = await store.getLink(workspaceId, linkKey) ?? await store.getLink(workspaceId, linkKeyFor(connection.provider, phone));
      const done = await sessions.withSession(connection, async (session) => {
        let row = link?.state === "linked" && String(link.boardId) === boardId && link.externalId
          ? await provider.getContact(session, link.externalId)
          : null;
        if (!row) {
          row = await provider.findContactByPhone(session, phone);
          if (row?.matchCount > 1) return false; // duplicates in Monday: never guess
        }
        if (!row?.externalId || row.name === clean) return false;
        await provider.renameItem(session, boardId, row.externalId, clean, { callerNameColumnId: connection.mapping.columns?.callerName?.id });
        return true;
      });
      // Remember what we wrote, so its webhook echo is ignored.
      await store.saveLink(workspaceId, linkKey, { lastWrittenName: clean });
      if (done) renamed += 1;
    }
    log.info?.("Caller renamed in Monday", { workspaceId, boards: boards.size, renamed });
    return { status: "done", renamed };
  }

  /**
   * One two-way pass over an agent's mapped board, run when its sync is
   * (re)set up and by the daily check when something was missed. For each
   * row whose caller Symantic knows:
   *  - Monday renamed it more recently than Symantic (and it isn't the name
   *    we wrote ourselves): the rename is applied in Symantic;
   *  - Symantic renamed it more recently than the row last changed (or the
   *    row still shows what we last wrote): the row is renamed in Monday.
   * Monday only records when a row last changed at all, so "our own last
   * write" is what decides most ties safely.
   */
  async function catchUp({ workspaceId, provider: key }) {
    const connection = await store.getConnection(workspaceId, key);
    const provider = providers.get(key);
    if (!isConnectionUsable(connection) || !provider?.listNamedRows) return { status: "skipped" };
    const boardId = String(connection.mapping.boardId);
    const rows = await sessions.withSession(connection, (session) =>
      provider.listNamedRows(session, connection.mapping, { maxPages: CATCH_UP_MAX_PAGES }));
    let fromMonday = 0;
    let toMonday = 0;
    for (const row of rows) {
      if (!row.phoneE164 || !row.name) continue;
      const [contact, link] = await Promise.all([
        store.getContactRecord(workspaceId, row.phoneE164),
        store.getLink(workspaceId, boardLinkKeyFor(key, boardId, row.phoneE164)),
      ]);
      if (!contact && !link) continue; // a caller Symantic doesn't know
      const symanticName = contact?.name ?? null;
      if (symanticName === row.name) continue;
      const mondayIsOurs = link?.lastWrittenName === row.name;
      const symanticNewer = Boolean(symanticName && contact.nameSource === "symantic" &&
        (mondayIsOurs || !row.updatedAt || (contact.nameUpdatedAt && contact.nameUpdatedAt > row.updatedAt)));
      if (symanticNewer) {
        await sessions.withSession(connection, (session) => provider.renameItem(session, boardId, row.externalId, symanticName,
          { callerNameColumnId: connection.mapping.columns?.callerName?.id }));
        await store.saveLink(workspaceId, boardLinkKeyFor(key, boardId, row.phoneE164), { lastWrittenName: symanticName });
        toMonday += 1;
        continue;
      }
      if (mondayIsOurs) continue;
      if (contact?.nameUpdatedAt && row.updatedAt && row.updatedAt <= contact.nameUpdatedAt) continue;
      const result = await applyFromMonday({
        workspaceId, provider: key, boardId, itemId: row.externalId, name: row.name, phoneE164: row.phoneE164, at: row.updatedAt ?? stamp(),
      });
      if (result.status === "renamed") fromMonday += 1;
    }
    log.info?.("Name catch-up done", { workspaceId, agentId: agentIdOf(key), rows: rows.length, fromMonday, toMonday });
    return { status: "done", fromMonday, toMonday };
  }

  /**
   * Once a day per agent with live name sync (from the keeper): ask Monday
   * whether our webhooks are still on the board - one small request. If one
   * is gone (removed in Monday, board permissions changed), re-create them,
   * which also runs a catch-up. A long gap since the keeper last saw this
   * connection means webhook deliveries may have been missed while we were
   * offline, so that also triggers a catch-up.
   */
  async function dailyCheck(connection) {
    if (!isConnectionUsable(connection)) return null;
    const { workspaceId, provider: key } = connection;
    const lastSeen = Date.parse(connection.nameKeeperSeenAt ?? "");
    await store.markNameKeeperSeen(workspaceId, key);
    if (nameSyncMode(connection) !== "instant") return null;
    if (Number.isFinite(lastSeen) && Number(now()) - lastSeen > OUTAGE_GAP_MS) {
      log.info?.("Name sync: background jobs were offline; catching up", { workspaceId, agentId: agentIdOf(key) });
      await enqueue({ kind: "name-catch-up", workspaceId, provider: key });
    }
    if (Number(now()) - Date.parse(connection.nameCheckedAt ?? 0) < DAILY_CHECK_MS) return null;
    await store.markNameChecked(workspaceId, key);
    const provider = providers.get(key);
    if (!provider?.listWebhooks) return null;
    const present = new Set(await sessions.withSession(connection, (session) => provider.listWebhooks(session, connection.nameWebhooks.boardId)));
    const missing = connection.nameWebhooks.ids.filter((id) => !present.has(String(id)));
    if (!missing.length) return "ok";
    log.warn?.("Name-sync webhooks missing in Monday; re-creating", { workspaceId, agentId: agentIdOf(key), missing: missing.length });
    await enqueue({ kind: "name-webhooks", workspaceId, provider: key });
    return "repaired";
  }

  return { registerWebhooks, removeWebhooks, applyFromMonday, pushToMonday, catchUp, dailyCheck };
}
