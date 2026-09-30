import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { followUpText, transcriptText } from "./facts.mjs";
import { agentIdOf, providerIdOf } from "./provider.mjs";
import { buildCallsRow, CALLS_BOARD_COLUMNS, callsBoardName, callsRowName } from "./monday/calls-board.mjs";

/**
 * The auto-created "Symantic AI Calls" board: one per connected agent, one
 * row per call, written next to (never instead of) the customer's own board.
 *
 * Board lifecycle, per agent (connection.callsBoard.status):
 *   active   - rows are written to it.
 *   failed   - Monday refused to create it (permissions, plan limit); the
 *              next call tries again.
 *   deleted  - it was deleted in Monday. It is NOT recreated automatically:
 *              calls are still answered and kept in Call History, and wait
 *              until an admin clicks Recreate Board (or restores it from
 *              Monday's trash). Then the full history is rebuilt.
 * connection.callsBoardEnabled === false - the admin chose Stop Logging.
 */

// A claim this old belongs to a crashed attempt and can be taken over.
const CLAIM_STALE_MS = 3 * 60 * 1000;
// Monday's "this board doesn't exist any more" answers.
const BOARD_GONE_STATES = new Set(["deleted", "archived", "missing"]);

// Write errors worth a board repair: a missing column or board, or a value
// rejected because the column's type was changed in Monday.
const REPAIRABLE_ERRORS = new Set([CRM_ERROR.MAPPING_INVALID, CRM_ERROR.NOT_FOUND, CRM_ERROR.INVALID_VALUE]);

// Any "Symantic AI Calls" board - this agent's, another agent's, or a
// leftover one - is filled in by us and is never offered as, or allowed to
// be, the customer's own mapped board: mapping it would sync calls into our
// own log and let edits there fight ours. Matched by the ids we saved (so a
// renamed board is still caught) and by name (so a board whose record we
// lost is too). Private/public doesn't matter: boards are hidden either way.
export const CALLS_BOARD_NAME_PATTERN = /^Symantic AI Calls(\s+-\s+.*)?$/i;

export const CALLS_BOARD_MAPPING_PROBLEM = Object.freeze({
  field: "board",
  code: "calls_board",
  message: "This is a Symantic AI Calls board, which Symantic AI fills in on its own. Choose one of your own boards, such as your Contacts or Leads board.",
});

// Ids of every calls board in the workspace, across all agents, including
// deleted ones (they can be restored from Monday's trash).
export async function callsBoardIdsOf(store, workspaceId) {
  const connections = await store.listWorkspaceConnections(workspaceId).catch(() => []);
  return new Set(connections.map((row) => row.callsBoard?.id).filter(Boolean).map(String));
}

// Checks a customer-board mapping against the board as it is in Monday now
// (board deleted, mapped column deleted or changed to another type), and
// flags a mapping that points at one of our calls boards. Renamed columns are
// fine: we write by column id.
export async function checkMapping(adapter, session, mapping, ours) {
  const outcome = await adapter.validateMapping(session, mapping);
  const problems = [...(outcome.problems ?? [])];
  const board = outcome.board ?? { id: mapping.boardId, name: mapping.boardName };
  if (isCallsBoard(board, ours)) problems.push(CALLS_BOARD_MAPPING_PROBLEM);
  return { ok: problems.length === 0, problems };
}

// True when a board is one of ours (see CALLS_BOARD_NAME_PATTERN).
export function isCallsBoard(board, ids) {
  if (!board) return false;
  return ids.has(String(board.id)) || CALLS_BOARD_NAME_PATTERN.test(String(board.name ?? "").trim());
}

// Everything about an agent's auto-created "Symantic AI Calls" board: create
// or reuse it, write one row per call, notice when it's deleted in Monday (or
// restored), and keep the Follow-Up column current. Used by sync.mjs; never
// throws a board problem up into the call sync itself.
export function createCallsLog({ store, providers, appUrl, metrics, log = console, now = Date.now }) {
  // Current time as ISO text, from the injectable clock (tests control it).
  const stamp = () => new Date(Number(now())).toISOString();

  // The agent's name, used to name the board "Symantic AI Calls - <agent>".
  // Null when unknown; the board is then named without it.
  async function agentName(connection) {
    const agentId = connection.agentId ?? agentIdOf(connection.provider);
    if (!agentId || !store.getAgent) return null;
    const agent = await store.getAgent(connection.workspaceId, agentId).catch(() => null);
    return agent?.name ?? null;
  }

  // Persists the board record and updates the in-memory connection so later
  // steps in the same run see it.
  async function save(connection, record) {
    await store.saveCallsBoard(connection.workspaceId, connection.provider, record);
    connection.callsBoard = record;
    return record;
  }

  // The board was deleted in Monday: remember it (keeping its id, so a
  // restore from Monday's trash can be recognised) and stop writing.
  async function markDeleted(connection) {
    const board = connection.callsBoard ?? {};
    if (board.status === "deleted") return board;
    metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: "deleted" });
    log.info?.("Calls board deleted in Monday", { workspaceId: connection.workspaceId, boardId: board.id });
    return save(connection, { ...board, status: "deleted", deletedAt: stamp() });
  }

  /**
   * Make sure this agent has exactly one usable calls board and return it.
   *  - an active board is returned as is (first adding any of our columns
   *    it's missing, e.g. "Call ID" on boards made before it existed);
   *  - a deleted board is only replaced when `recreate` is set (the admin's
   *    Recreate Board), never on its own;
   *  - otherwise reuse a board we already made under the agent's board name
   *    (a lost save, a timed-out attempt), else create one.
   * A per-agent claim on the connection row stops two workers from creating
   * boards at once. Throws a CrmError when Monday refuses (recorded on the
   * connection), and a retryable LEASE_BUSY while another worker holds the
   * claim.
   */
  async function ensureBoard(session, connection, { recreate = false } = {}) {
    const existing = connection.callsBoard;
    const provider = providers.get(connection.provider);
    if (existing?.status === "active" && existing.id) {
      const missing = CALLS_BOARD_COLUMNS.some((column) => !existing.columns?.[column.key]);
      if (!missing || !provider.repairCallsBoard) return existing;
      const repaired = await provider.repairCallsBoard(session, existing.id, existing.columns);
      return repaired ? save(connection, { ...existing, columns: repaired.columns }) : existing;
    }
    if (existing?.status === "deleted" && !recreate) {
      throw new CrmError(CRM_ERROR.NOT_FOUND, "Calls board was deleted; waiting for an admin", { resource: "calls_board" });
    }
    if (!await store.claimCallsBoard(connection.workspaceId, connection.provider, CLAIM_STALE_MS)) {
      throw new CrmError(CRM_ERROR.LEASE_BUSY, "Calls board is being created", { retryAfterSeconds: 30 });
    }
    const name = callsBoardName(await agentName(connection));
    try {
      const excludeId = existing?.status === "deleted" ? existing.id : null;
      const reused = await provider.findCallsBoard?.(session, { name, excludeId });
      const { boardId, columns } = reused ?? await provider.createCallsBoard(session, { name });
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: reused ? "reused" : "created" });
      return save(connection, { id: boardId, columns, status: "active", createdAt: stamp() });
    } catch (error) {
      const record = { id: null, columns: null, status: "failed", errorCode: boardErrorCode(error), failedAt: stamp() };
      await save(connection, record).catch(() => {});
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: record.errorCode });
      log.warn?.("Calls board not created", { workspaceId: connection.workspaceId, ...describeError(error) });
      throw error;
    }
  }

  // The Monday row (item name plus column values) for one call on this board.
  function rowFor(connection, call, facts) {
    return {
      name: callsRowName(facts),
      values: buildCallsRow({
        facts,
        call,
        columns: connection.callsBoard.columns,
        appUrl,
        transcript: transcriptText(call.transcript),
        followUp: followUpText(call.followUp),
      }),
    };
  }

  /**
   * One row for this call on the agent's calls board. Returns:
   *   { status: "written", itemId, boardId } - the row exists (new or found);
   *   { status: "held" }    - the board was deleted; the call waits for Recreate;
   *   { status: "off" }     - the admin switched the calls board off;
   *   { status: "refused" } - Monday won't let us create the board.
   * `verifyExisting` (rebuilds and catch-ups) first looks the call up by its
   * Call ID, so a row that's already there is linked instead of duplicated.
   * Outages throw, so the caller retries.
   */
  async function logCall(session, connection, call, facts, { idempotencyKey, verifyExisting = false }) {
    const provider = providers.get(connection.provider);
    if (!provider?.createCallsRow) return { status: "off" };
    if (connection.callsBoardEnabled === false) return { status: "off" };
    if (connection.callsBoard?.status === "deleted") return { status: "held" };
    let board;
    try {
      board = await ensureBoard(session, connection);
    } catch (error) {
      if (isBoardRefusal(error)) return { status: "refused" };
      throw error;
    }
    try {
      if (verifyExisting) {
        const found = await provider.findCallsRow?.(session, board, facts.callId);
        if (found) return { status: "written", itemId: found, boardId: board.id };
      }
      // Keyed per board: a rebuilt board gets its own rows, while retries on
      // the same board are replayed by Monday instead of duplicated.
      const itemId = await provider.createCallsRow(session, board.id, rowFor(connection, call, facts), {
        idempotencyKey: `${idempotencyKey}-${board.id}`,
      });
      return { status: "written", itemId, boardId: board.id };
    } catch (error) {
      if (!(error instanceof CrmError) || !REPAIRABLE_ERRORS.has(error.code)) throw error;
      // Board or column gone, or a column changed to another type in Monday
      // (its value is then rejected). A deleted board waits for the admin; a
      // removed or retyped column is replaced and the write tried once more.
      const state = await provider.callsBoardState?.(session, board.id).catch(() => "unknown");
      if (BOARD_GONE_STATES.has(state)) {
        await markDeleted(connection);
        return { status: "held" };
      }
      const repaired = await provider.repairCallsBoard?.(session, board.id, board.columns);
      // Nothing changed on the board: the value itself was bad, not a column.
      if (!repaired || JSON.stringify(repaired.columns) === JSON.stringify(board.columns)) throw error;
      await save(connection, { ...board, columns: repaired.columns });
      const itemId = await provider.createCallsRow(session, board.id, rowFor(connection, call, facts), {
        idempotencyKey: `${idempotencyKey}-${board.id}-r`,
      });
      return { status: "written", itemId, boardId: board.id };
    }
  }

  /**
   * The 10-minute check: is this agent's board still in Monday? Returns
   * "deleted" when it just disappeared, "restored" when a deleted board is
   * back (restored from Monday's trash), otherwise null.
   */
  async function checkBoard(session, connection) {
    const provider = providers.get(connection.provider);
    const board = connection.callsBoard;
    if (!board?.id || !provider?.callsBoardState || connection.callsBoardEnabled === false) return null;
    if (board.status !== "active" && board.status !== "deleted") return null;
    const state = await provider.callsBoardState(session, board.id);
    if (board.status === "active" && BOARD_GONE_STATES.has(state)) {
      await markDeleted(connection);
      return "deleted";
    }
    if (board.status === "deleted" && state === "active") {
      await save(connection, { id: board.id, columns: board.columns, status: "active", createdAt: board.createdAt ?? stamp(), restoredAt: stamp() });
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: "restored" });
      return "restored";
    }
    return null;
  }

  // A follow-up edited in Call History after the call: rewrite the Follow-Up
  // cell on that call's row. Skipped when the row is on an older board (it
  // was recreated since) or the board isn't active.
  async function updateFollowUp(session, connection, call) {
    const provider = providers.get(connection.provider);
    const board = connection.callsBoard;
    const column = board?.columns?.followUp;
    if (!provider?.updateCallsRow || board?.status !== "active" || !column || !call.crmCallsItemId) return false;
    if (call.crmCallsBoardId && String(call.crmCallsBoardId) !== String(board.id)) return false;
    const text = followUpText(call.followUp);
    await provider.updateCallsRow(session, board.id, call.crmCallsItemId, { [column]: { text: text ?? "" } });
    return true;
  }

  return { ensureBoard, logCall, checkBoard, markDeleted, updateFollowUp };
}

// Is this call's row on the agent's current calls board? Rows written before
// we tracked the board id count as current.
export function callsRowIsCurrent(call, connection) {
  if (!call?.crmCallsItemId) return false;
  if (!call.crmCallsBoardId) return true;
  return String(call.crmCallsBoardId) === String(connection?.callsBoard?.id ?? "");
}

// Monday said no to the board itself - retrying won't change that.
function isBoardRefusal(error) {
  return error instanceof CrmError && !error.retryable;
}

// Maps a board creation failure to the code the card explains: forbidden (no
// permission), board_limit (plan limit), unavailable (Monday down, retried),
// or failed.
export function boardErrorCode(error) {
  if (error instanceof CrmError) {
    if (error.code === CRM_ERROR.FORBIDDEN) return "forbidden";
    if (/limit/i.test(`${error.providerCode ?? ""} ${error.message ?? ""}`)) return "board_limit";
    if (error.retryable) return "unavailable";
  }
  return "failed";
}
