import { CRM_ERROR, CrmError } from "./errors.mjs";

// What the "Added By" column says on a row we create.
export function addedByText({ agentName = null, source = "call" } = {}) {
  if (source === "contacts") return "Added from Symantic AI Contacts";
  return agentName ? `Added by ${agentName} - AI Receptionist` : "Added by Symantic AI Receptionist";
}

/**
 * Creates a row on the customer's board with name and phone (as before) plus
 * "Added By" text, so the customer can filter the rows we added. The column
 * is found or created first; if that fails, or Monday rejects the column
 * (deleted a moment ago), the row is still created without it - a lead is
 * never lost over a label.
 */
export function createLeadWriter({ store, log = console }) {
  return async function createLeadWithAddedBy(provider, session, connection, input, { idempotencyKey, text }) {
    const boardId = String(connection.mapping?.boardId ?? "");
    let columnId = null;
    if (boardId && provider.ensureAddedByColumn) {
      try {
        const saved = connection.addedByColumn?.boardId === boardId ? connection.addedByColumn.id : null;
        columnId = await provider.ensureAddedByColumn(session, boardId, saved);
        if (columnId && columnId !== saved) {
          connection.addedByColumn = { id: columnId, boardId };
          await store.saveAddedByColumn?.(connection.workspaceId, connection.provider, connection.addedByColumn);
        }
      } catch (error) {
        log.warn?.("Added By column unavailable", { workspaceId: connection.workspaceId, name: error?.name, code: error?.code });
        columnId = null;
      }
    }
    if (!columnId) return provider.createLead(session, input, { idempotencyKey });
    try {
      return await provider.createLead(session, { ...input, addedBy: { columnId, text } }, { idempotencyKey });
    } catch (error) {
      // Only a rejected column is retried: any other failure (an outage, a
      // timeout) may already have created the row, and a retry would double it.
      if (!(error instanceof CrmError) || ![CRM_ERROR.MAPPING_INVALID, CRM_ERROR.INVALID_VALUE].includes(error.code)) throw error;
      if (connection.addedByColumn) {
        delete connection.addedByColumn;
        await store.saveAddedByColumn?.(connection.workspaceId, connection.provider, null).catch(() => {});
      }
      log.warn?.("Lead created without Added By", { workspaceId: connection.workspaceId, code: error.code });
      return provider.createLead(session, input, { idempotencyKey: idempotencyKey ? `${idempotencyKey}-plain` : undefined });
    }
  };
}
