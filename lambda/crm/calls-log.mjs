import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { followUpText, transcriptText } from "./facts.mjs";
import { agentIdOf, providerIdOf } from "./provider.mjs";
import { buildCallsRow, callsBoardName, callsRowName } from "./monday/calls-board.mjs";

/**
 * The auto-created "Symantic AI Calls" board: one per connected agent, one
 * row per call. It is best effort around the customer's own board - a
 * refusal to create the board (permissions, plan limits) is recorded on the
 * connection and shown in settings, never allowed to block the rest.
 */
// A claim this old belongs to a crashed attempt and can be taken over.
const CLAIM_STALE_MS = 3 * 60 * 1000;

export function createCallsLog({ store, providers, appUrl, metrics, log = console, now = Date.now }) {
  async function agentName(connection) {
    const agentId = connection.agentId ?? agentIdOf(connection.provider);
    if (!agentId || !store.getAgent) return null;
    const agent = await store.getAgent(connection.workspaceId, agentId).catch(() => null);
    return agent?.name ?? null;
  }

  // Make sure this agent has exactly one calls board: reuse the saved one,
  // else one we already created under the agent's board name (a lost save,
  // a timed-out attempt, a reconnect), else create it. A per-agent claim on
  // the connection row stops two workers creating boards at the same time.
  // Throws a CrmError when Monday refuses (recorded on the connection) and a
  // retryable LEASE_BUSY while another worker holds the claim.
  async function ensureBoard(session, connection, { force = false } = {}) {
    const existing = connection.callsBoard;
    if (!force && existing?.status === "active" && existing.id) return existing;
    const provider = providers.get(connection.provider);
    if (!await store.claimCallsBoard(connection.workspaceId, connection.provider, CLAIM_STALE_MS)) {
      throw new CrmError(CRM_ERROR.LEASE_BUSY, "Calls board is being created", { retryAfterSeconds: 30 });
    }
    const name = callsBoardName(await agentName(connection));
    try {
      const reused = await provider.findCallsBoard?.(session, { name, excludeId: force ? existing?.id : null });
      const { boardId, columns } = reused ?? await provider.createCallsBoard(session, { name });
      const record = { id: boardId, columns, status: "active", createdAt: new Date(Number(now())).toISOString() };
      await store.saveCallsBoard(connection.workspaceId, connection.provider, record);
      connection.callsBoard = record;
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: reused ? "reused" : "created" });
      return record;
    } catch (error) {
      const record = { id: null, columns: null, status: "failed", errorCode: boardErrorCode(error), failedAt: new Date(Number(now())).toISOString() };
      await store.saveCallsBoard(connection.workspaceId, connection.provider, record).catch(() => {});
      connection.callsBoard = record;
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: record.errorCode });
      log.warn?.("Calls board not created", { workspaceId: connection.workspaceId, ...describeError(error) });
      throw error;
    }
  }

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
   * One row for this call. Returns the row id, or null when the board can't
   * exist (Monday refused to create it). Outages throw, so the call retries.
   */
  async function logCall(session, connection, call, facts, { idempotencyKey }) {
    const provider = providers.get(connection.provider);
    if (!provider?.createCallsRow) return null;
    let board;
    try {
      board = await ensureBoard(session, connection);
    } catch (error) {
      if (isBoardRefusal(error)) return null;
      throw error;
    }
    try {
      return await provider.createCallsRow(session, board.id, rowFor(connection, call, facts), { idempotencyKey });
    } catch (error) {
      // Board deleted in Monday (or a column removed): build a new one once.
      if (!(error instanceof CrmError) || (error.code !== CRM_ERROR.MAPPING_INVALID && error.code !== CRM_ERROR.NOT_FOUND)) throw error;
      metrics?.count("CallsBoard", { Provider: providerIdOf(connection.provider), Outcome: "recreated" });
      try {
        board = await ensureBoard(session, connection, { force: true });
      } catch (createError) {
        if (isBoardRefusal(createError)) return null;
        throw createError;
      }
      try {
        return await provider.createCallsRow(session, board.id, rowFor(connection, call, facts), { idempotencyKey: `${idempotencyKey}-r` });
      } catch (retryError) {
        if (!isBoardRefusal(retryError)) throw retryError;
        await store.saveCallsBoard(connection.workspaceId, connection.provider, {
          ...board, status: "failed", errorCode: boardErrorCode(retryError), failedAt: new Date(Number(now())).toISOString(),
        }).catch(() => {});
        return null;
      }
    }
  }

  async function updateFollowUp(session, connection, call) {
    const provider = providers.get(connection.provider);
    const board = connection.callsBoard;
    const column = board?.columns?.followUp;
    if (!provider?.updateCallsRow || board?.status !== "active" || !column || !call.crmCallsItemId) return false;
    const text = followUpText(call.followUp);
    await provider.updateCallsRow(session, board.id, call.crmCallsItemId, { [column]: { text: text ?? "" } });
    return true;
  }

  return { ensureBoard, logCall, updateFollowUp };
}

// Monday said no to the board itself - retrying won't change that.
function isBoardRefusal(error) {
  return error instanceof CrmError && !error.retryable;
}

export function boardErrorCode(error) {
  if (error instanceof CrmError) {
    if (error.code === CRM_ERROR.FORBIDDEN) return "forbidden";
    if (/limit/i.test(`${error.providerCode ?? ""} ${error.message ?? ""}`)) return "board_limit";
    if (error.retryable) return "unavailable";
  }
  return "failed";
}
