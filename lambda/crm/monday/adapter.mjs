import { CRM_ERROR, CrmError } from "../errors.mjs";
import { countryForE164, nationalNumber, toE164 } from "../phone.mjs";
import { CALLS_BOARD_COLUMNS } from "./calls-board.mjs";

const MONDAY_PROVIDER_ID = "monday";

// Which Monday column types each mapped field accepts. Everything we write
// is checked against this when the mapping is saved, and again (by Monday)
// on every write.
export const FIELD_TYPES = Object.freeze({
  phone: ["phone"],
  email: ["email"],
  status: ["status"],
  owner: ["people"],
  lastCall: ["date"],
  outcome: ["text", "long_text"],
  followUpDate: ["date"],
  nextAppointment: ["date"],
  source: ["text", "long_text"],
  transcriptSummary: ["text", "long_text"],
  fullTranscript: ["long_text"],
  audioLink: ["text", "long_text", "link"],
  callDuration: ["numbers", "text"],
  callerName: ["text", "long_text"],
  companyName: ["text", "long_text"],
  date: ["date"],
  time: ["text", "hour"],
  sentiment: ["text"],
  appointment: ["checkbox", "text"],
  followUp: ["text", "long_text"],
  direction: ["text"],
  intent: ["text", "long_text"],
});
const REQUIRED_FIELDS = Object.freeze(["phone"]);

const ITEM_FIELDS = `
  id
  name
  state
  url
  updated_at
  board { id }
  column_values(ids: $columns) { id type text value }
`;

/**
 * Monday implementation of the CrmProvider contract (see ../provider.mjs).
 * Nothing Monday-shaped leaves this module: callers get CrmContact objects
 * and CrmError failures.
 */
export function createMondayCrmAdapter({ graphql }) {
  function readColumns(mapping) {
    return ["phone", "email", "status", "owner"]
      .map((field) => mapping?.columns?.[field]?.id)
      .filter(Boolean);
  }

  function requireBoard(mapping) {
    const boardId = mapping?.boardId;
    if (!boardId || !mapping?.columns?.phone?.id) {
      throw new CrmError(CRM_ERROR.MAPPING_INVALID, "Monday field mapping is incomplete", {
        resource: "mapping",
      });
    }
    return String(boardId);
  }

  function toContact(item, mapping) {
    if (!item || item.state !== "active") return null;
    if (String(item.board?.id ?? "") !== String(mapping.boardId)) return null;
    const values = new Map((item.column_values ?? []).map((value) => [value.id, value]));
    const phoneValue = values.get(mapping.columns.phone?.id);
    const emailValue = values.get(mapping.columns.email?.id);
    return {
      externalId: String(item.id),
      name: typeof item.name === "string" ? item.name : "",
      phoneE164: readPhone(phoneValue),
      email: readEmail(emailValue),
      status: textOf(values.get(mapping.columns.status?.id)),
      ownerName: textOf(values.get(mapping.columns.owner?.id)),
      url: typeof item.url === "string" ? item.url : undefined,
      updatedAt: item.updated_at,
    };
  }

  async function searchByColumn(session, columnId, value, operation) {
    const mapping = session.mapping;
    const boardId = requireBoard(mapping);
    const data = await graphql.request({
      accessToken: session.accessToken,
      operation,
      timeoutMs: session.timeoutMs,
      query: `query ($board: ID!, $column: String!, $value: String!, $columns: [String!]) {
        items_page_by_column_values(
          board_id: $board,
          limit: 25,
          columns: [{ column_id: $column, column_values: [$value] }]
        ) { items { ${ITEM_FIELDS} } }
      }`,
      variables: { board: boardId, column: columnId, value, columns: readColumns(mapping) },
    });
    return (data?.items_page_by_column_values?.items ?? [])
      .map((item) => toContact(item, mapping))
      .filter(Boolean);
  }

  function newest(contacts) {
    return [...contacts].sort((a, b) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
    )[0] ?? null;
  }

  function withMatchCount(contact, count) {
    if (!contact) return null;
    const { updatedAt: _updatedAt, ...rest } = contact;
    return { ...rest, matchCount: count };
  }

  return {
    id: MONDAY_PROVIDER_ID,

    async findContactByPhone(session, phoneE164) {
      const national = nationalNumber(phoneE164);
      if (!national) return null;
      // Monday matches phone columns by "contains", so search on the national
      // digits (what people type) and confirm each candidate as E.164 here.
      const candidates = await searchByColumn(
        session,
        session.mapping?.columns?.phone?.id,
        national,
        "find_by_phone",
      );
      const matches = candidates.filter((contact) => contact.phoneE164 === phoneE164);
      return withMatchCount(newest(matches), matches.length);
    },

    async findContactByEmail(session, email) {
      const columnId = session.mapping?.columns?.email?.id;
      const wanted = normalizeEmail(email);
      if (!columnId || !wanted) return null;
      const candidates = await searchByColumn(session, columnId, wanted, "find_by_email");
      const matches = candidates.filter((contact) => normalizeEmail(contact.email) === wanted);
      return withMatchCount(newest(matches), matches.length);
    },

    async getContact(session, externalId) {
      const mapping = session.mapping;
      requireBoard(mapping);
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "get_item",
        timeoutMs: session.timeoutMs,
        query: `query ($ids: [ID!], $columns: [String!]) { items(ids: $ids) { ${ITEM_FIELDS} } }`,
        variables: { ids: [String(externalId)], columns: readColumns(mapping) },
      });
      return withMatchCount(toContact(data?.items?.[0], mapping), 1);
    },

    async createLead(session, input, { idempotencyKey } = {}) {
      const mapping = session.mapping;
      const boardId = requireBoard(mapping);
      const values = buildColumnValues(mapping, {
        ...input.fields,
        phoneE164: input.phoneE164,
        email: input.email,
      }, { isNew: true });
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "create_item",
        idempotencyKey,
        query: `mutation ($board: ID!, $name: String!, $values: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $values, create_labels_if_missing: false) {
            id name url
          }
        }`,
        variables: {
          board: boardId,
          name: truncate(input.name || "New caller", 255),
          values: JSON.stringify(values),
        },
      });
      const item = data?.create_item;
      if (!item?.id) {
        throw new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created item");
      }
      return {
        externalId: String(item.id),
        name: item.name,
        phoneE164: input.phoneE164,
        email: input.email,
        url: item.url,
      };
    },

    async logCallActivity(session, externalId, activity, { fields, idempotencyKey } = {}) {
      const mapping = session.mapping;
      const boardId = requireBoard(mapping);
      const values = fields ? buildColumnValues(mapping, fields, { isNew: false }) : {};
      const writeFields = Object.keys(values).length > 0;
      // One request for both writes: one API call against the customer's
      // daily Monday budget instead of two.
      const result = await graphql.request({
        accessToken: session.accessToken,
        operation: writeFields ? "log_call_and_fields" : "log_call",
        idempotencyKey,
        allowPartial: true,
        query: writeFields
          ? `mutation ($board: ID!, $item: ID!, $values: JSON!, $body: String!) {
              fields: change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values, create_labels_if_missing: false) { id }
              note: create_update(item_id: $item, body: $body) { id }
            }`
          : `mutation ($item: ID!, $body: String!) {
              note: create_update(item_id: $item, body: $body) { id }
            }`,
        variables: {
          item: String(externalId),
          body: activity.html,
          ...(writeFields ? { board: boardId, values: JSON.stringify(values) } : {}),
        },
      });
      const activityId = result.data?.note?.id;
      if (!activityId) {
        throw pickError(result.errors) ??
          new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created update");
      }
      const fieldsApplied = writeFields && Boolean(result.data?.fields?.id);
      return {
        activityId: String(activityId),
        fieldsApplied,
        ...(writeFields && !fieldsApplied
          ? { fieldsError: pickError(result.errors) ?? new CrmError(CRM_ERROR.PROVIDER_ERROR, "Fields not applied") }
          : {}),
      };
    },

    // Column writes only, no call note - for a change made in Symantic after
    // the call already synced (e.g. its follow-up).
    async updateFields(session, externalId, fields, { idempotencyKey } = {}) {
      const mapping = session.mapping;
      const boardId = requireBoard(mapping);
      const values = buildColumnValues(mapping, fields, { isNew: false });
      if (!Object.keys(values).length) return { fieldsApplied: false };
      await graphql.request({
        accessToken: session.accessToken,
        operation: "update_fields",
        idempotencyKey,
        query: `mutation ($board: ID!, $item: ID!, $values: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values, create_labels_if_missing: false) { id }
        }`,
        variables: { board: boardId, item: String(externalId), values: JSON.stringify(values) },
      });
      return { fieldsApplied: true };
    },

    async findActivityByRef(session, externalId, ref) {
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "find_update",
        query: `query ($ids: [ID!]) { items(ids: $ids) { id updates(limit: 50) { id text_body } } }`,
        variables: { ids: [String(externalId)] },
      });
      const item = data?.items?.[0];
      if (!item) throw new CrmError(CRM_ERROR.NOT_FOUND, "Monday item not found", { resource: "item" });
      const match = (item.updates ?? []).find(
        (update) => typeof update?.text_body === "string" && update.text_body.includes(ref),
      );
      return match ? String(match.id) : null;
    },

    // ---- connection management (settings API only) ----

    async describeAccount(session) {
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "me",
        query: "query { me { id name email account { id name slug } } }",
      });
      const me = data?.me;
      return {
        accountId: me?.account?.id ? String(me.account.id) : undefined,
        accountName: me?.account?.name,
        accountSlug: me?.account?.slug,
        userId: me?.id ? String(me.id) : undefined,
        userName: me?.name,
      };
    },

    async listBoards(session) {
      const boards = await queryBoards(session, null);
      return boards.filter((board) => !/^Subitems of /i.test(board.name));
    },

    async listUsers(session) {
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "list_users",
        query: "query { users(kind: non_guests, limit: 500) { id name enabled } }",
      });
      return (data?.users ?? [])
        .filter((user) => user?.enabled !== false)
        .map((user) => ({ id: String(user.id), name: user.name }));
    },

    async validateMapping(session, mapping) {
      const problems = [];
      if (!mapping?.boardId) {
        return { ok: false, problems: [{ field: "board", code: "missing", message: "Choose a board." }] };
      }
      const [board] = await queryBoards(session, [String(mapping.boardId)]);
      if (!board) {
        return {
          ok: false,
          problems: [{ field: "board", code: "not_found", message: "The board no longer exists or isn't shared with this connection." }],
        };
      }
      const byId = new Map(board.columns.map((column) => [column.id, column]));
      for (const [field, allowed] of Object.entries(FIELD_TYPES)) {
        const columnId = mapping.columns?.[field]?.id;
        if (!columnId) {
          if (REQUIRED_FIELDS.includes(field)) {
            problems.push({ field, code: "missing", message: "A phone column is required to match callers." });
          }
          continue;
        }
        const column = byId.get(columnId);
        if (!column) {
          problems.push({ field, code: "not_found", message: "This column was deleted or renamed on the board." });
        } else if (!allowed.includes(column.type)) {
          problems.push({ field, code: "wrong_type", message: `This column must be a ${allowed.join(" or ")} column.` });
        }
      }
      const statusColumn = byId.get(mapping.columns?.status?.id);
      if (statusColumn?.type === "status") {
        for (const [key, label] of Object.entries(mapping.labels ?? {})) {
          if (label && !statusColumn.labels.includes(label)) {
            problems.push({ field: `labels.${key}`, code: "not_found", message: `The status "${label}" doesn't exist on this column.` });
          }
        }
      } else if (Object.values(mapping.labels ?? {}).some(Boolean)) {
        problems.push({ field: "labels", code: "missing", message: "Status labels need a status column." });
      }
      if (mapping.defaultOwnerId) {
        if (!mapping.columns?.owner?.id) {
          problems.push({ field: "defaultOwnerId", code: "missing", message: "A default owner needs an owner column." });
        } else {
          const users = await this.listUsers(session);
          if (!users.some((user) => user.id === String(mapping.defaultOwnerId))) {
            problems.push({ field: "defaultOwnerId", code: "not_found", message: "That person is no longer an active user." });
          }
        }
      }
      return { ok: problems.length === 0, problems, board };
    },

    async createColumn(session, boardId, title, columnType) {
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "create_column",
        query: `mutation ($board: ID!, $title: String!, $type: ColumnType!) {
          create_column(board_id: $board, title: $title, column_type: $type) { id title type }
        }`,
        variables: { board: String(boardId), title, type: columnType },
      });
      const col = data?.create_column;
      if (!col?.id) throw new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created column");
      return { id: col.id, title: col.title, type: col.type };
    },

    // ---- the auto-created calls board ----

    // Creates the board in the account's Main Workspace as a Main (team
    // visible) board, then its fixed columns. If a column can't be created
    // the half-built board is archived, so a retry never leaves duplicates.
    async createCallsBoard(session, { name }) {
      const created = await graphql.request({
        accessToken: session.accessToken,
        operation: "create_board",
        query: `mutation ($name: String!) { create_board(board_name: $name, board_kind: public) { id } }`,
        variables: { name },
      });
      const boardId = created?.create_board?.id ? String(created.create_board.id) : null;
      if (!boardId) throw new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created board");
      const columns = {};
      try {
        for (const column of CALLS_BOARD_COLUMNS) {
          const defaults = column.labels
            ? JSON.stringify({ labels: Object.fromEntries(column.labels.map((label, index) => [String(index + 1), label])) })
            : undefined;
          const data = await graphql.request({
            accessToken: session.accessToken,
            operation: "create_column",
            query: `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
              create_column(board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id }
            }`,
            variables: { board: boardId, title: column.title, type: column.type, defaults },
          });
          const id = data?.create_column?.id;
          if (!id) throw new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created column");
          columns[column.key] = String(id);
        }
      } catch (error) {
        await graphql.request({
          accessToken: session.accessToken,
          operation: "archive_board",
          query: `mutation ($board: ID!) { archive_board(board_id: $board) { id } }`,
          variables: { board: boardId },
        }).catch(() => {});
        throw error;
      }
      return { boardId, columns };
    },

    async createCallsRow(session, boardId, { name, values }, { idempotencyKey } = {}) {
      const data = await graphql.request({
        accessToken: session.accessToken,
        operation: "create_calls_row",
        idempotencyKey,
        query: `mutation ($board: ID!, $name: String!, $values: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $values, create_labels_if_missing: false) { id }
        }`,
        variables: { board: String(boardId), name, values: JSON.stringify(values) },
      });
      const id = data?.create_item?.id;
      if (!id) throw new CrmError(CRM_ERROR.PROVIDER_ERROR, "Monday did not return the created row");
      return String(id);
    },

    async updateCallsRow(session, boardId, itemId, values) {
      if (!Object.keys(values).length) return;
      await graphql.request({
        accessToken: session.accessToken,
        operation: "update_fields",
        query: `mutation ($board: ID!, $item: ID!, $values: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values, create_labels_if_missing: false) { id }
        }`,
        variables: { board: String(boardId), item: String(itemId), values: JSON.stringify(values) },
      });
    },

    suggestMapping,
  };

  async function queryBoards(session, ids) {
    // One board by id (validation) or the account's most recently used ones
    // (the mapping picker). `ids` is left out entirely rather than sent null.
    // Do not select workspace metadata here. Monday allows board access with
    // boards:read, but resolving workspace fields can require the separate
    // workspaces:read scope. Field mapping does not need workspace metadata.
    const data = await graphql.request({
      accessToken: session.accessToken,
      operation: "list_boards",
      query: ids
        ? `query ($ids: [ID!]) {
            boards(ids: $ids) { id name columns { id title type settings } }
          }`
        : `query {
            boards(limit: 100, state: active, order_by: used_at) {
              id name board_kind type columns { id title type settings }
            }
          }`,
      variables: ids ? { ids } : {},
    });
    // The picker lists only boards the whole team can see: private boards
    // (and subitem/document boards) are left out. Validating an already
    // mapped board by id skips this filter so an existing mapping keeps working.
    const boards = (data?.boards ?? []).filter((board) =>
      ids || (board.board_kind !== "private" && (board.type === undefined || board.type === null || board.type === "board"))
    );
    return boards.map((board) => ({
      id: String(board.id),
      name: board.name,
      workspaceName: null,
      columns: (board.columns ?? []).map((column) => ({
        id: column.id,
        title: column.title,
        type: column.type,
        labels: column.type === "status" ? statusLabels(column.settings) : [],
      })),
    }));
  }
}

/** A starting mapping for a board, by column type and title. */
export function suggestMapping(board) {
  const columns = board?.columns ?? [];
  const pick = (types, pattern) => {
    const ofType = columns.filter((column) => types.includes(column.type));
    const column = (pattern && ofType.find((c) => pattern.test(c.title))) ?? (pattern ? null : ofType[0]);
    return column ? { id: column.id, type: column.type, title: column.title } : undefined;
  };
  const status = pick(["status"], /status|stage/i) ?? pick(["status"]);
  const labels = columns.find((column) => column.id === status?.id)?.labels ?? [];
  return {
    boardId: board?.id,
    boardName: board?.name,
    columns: Object.fromEntries(Object.entries({
      phone: pick(["phone"]),
      email: pick(["email"]),
      status,
      owner: pick(["people"], /owner|assign|rep|sales/i) ?? pick(["people"]),
      lastCall: pick(["date"], /last.*(call|contact|interaction)/i),
      outcome: pick(["text", "long_text"], /outcome|result/i),
      followUpDate: pick(["date"], /follow/i),
      nextAppointment: pick(["date"], /appoint|meeting|next/i),
      source: pick(["text", "long_text"], /source/i),
      transcriptSummary: pick(["text", "long_text"], /summary|transcript.*sum/i),
      fullTranscript: pick(["long_text"], /transcript/i),
      audioLink: pick(["text", "long_text", "link"], /audio|recording|listen/i),
      callDuration: pick(["numbers", "text"], /duration|length/i),
      callerName: pick(["text", "long_text"], /caller.*name|full.*name|contact.*name/i),
      companyName: pick(["text", "long_text"], /company|organization|org/i),
      date: pick(["date"], /^date$|call.*date|date.*time/i),
      time: pick(["text", "hour"], /^time$|call.*time|date.*time/i),
      sentiment: pick(["text"], /sentiment|mood/i),
      appointment: pick(["checkbox", "text"], /appointment.*set|booked/i),
      followUp: pick(["text", "long_text"], /follow.*up|action/i),
      direction: pick(["text"], /direction|inbound|outbound/i),
      intent: pick(["text", "long_text"], /intent|reason|purpose/i),
    }).filter(([, value]) => value)),
    labels: {
      newLead: labels.find((label) => /new/i.test(label)) ?? null,
      followUp: labels.find((label) => /follow|call ?back|contact/i.test(label)) ?? null,
    },
    defaultOwnerId: null,
  };
}

/** Translate a domain field patch into Monday column_values JSON. */
export function buildColumnValues(mapping, patch, { isNew }) {
  const columns = mapping?.columns ?? {};
  const values = {};
  const set = (field, value) => {
    const column = columns[field];
    if (column?.id && value !== undefined) values[column.id] = value;
  };
  const textValue = (field, text) =>
    columns[field]?.type === "long_text" ? { text } : text;

  if (isNew && patch.phoneE164) {
    set("phone", {
      phone: patch.phoneE164,
      countryShortName: countryForE164(patch.phoneE164) ?? "US",
    });
  }
  if (isNew && patch.email) set("email", { email: patch.email, text: patch.email });
  if (isNew && patch.source) set("source", textValue("source", patch.source));
  if (isNew && patch.assignDefaultOwner && mapping.defaultOwnerId) {
    set("owner", { personsAndTeams: [{ id: Number(mapping.defaultOwnerId), kind: "person" }] });
  }
  const label = patch.status === "new_lead"
    ? mapping.labels?.newLead
    : patch.status === "follow_up" ? mapping.labels?.followUp : null;
  if (label) set("status", { label });
  if (patch.lastCallAt) set("lastCall", utcDateTime(patch.lastCallAt));
  if (patch.outcome) set("outcome", textValue("outcome", truncate(patch.outcome, 2000)));
  if (patch.followUpDate) set("followUpDate", { date: patch.followUpDate });
  if (patch.nextAppointmentAt === null) set("nextAppointment", null);
  else if (patch.nextAppointmentAt) set("nextAppointment", utcDateTime(patch.nextAppointmentAt));
  if (patch.transcriptSummary) set("transcriptSummary", textValue("transcriptSummary", truncate(patch.transcriptSummary, 5000)));
  if (patch.fullTranscript) set("fullTranscript", { text: truncate(patch.fullTranscript, 50000) });
  if (patch.audioLink) {
    const col = columns.audioLink;
    if (col?.id) {
      values[col.id] = col.type === "link"
        ? { url: patch.audioLink, text: "Listen" }
        : textValue("audioLink", patch.audioLink);
    }
  }
  if (patch.callDuration !== undefined && patch.callDuration !== null) {
    const col = columns.callDuration;
    if (col?.id) {
      values[col.id] = col.type === "numbers" ? String(patch.callDuration) : textValue("callDuration", `${patch.callDuration} min`);
    }
  }
  if (patch.callerName) set("callerName", textValue("callerName", truncate(patch.callerName, 500)));
  if (patch.companyName) set("companyName", textValue("companyName", truncate(patch.companyName, 500)));
  if (patch.date) set("date", utcDateTime(patch.date));
  if (patch.time) {
    const col = columns.time;
    if (col?.id) {
      const d = new Date(patch.time);
      if (!Number.isNaN(d.getTime())) {
        values[col.id] = col.type === "hour" ? { hour: d.getUTCHours(), minute: d.getUTCMinutes() } : d.toISOString().slice(11, 19);
      }
    }
  }
  if (patch.sentiment) set("sentiment", truncate(patch.sentiment, 100));
  if (typeof patch.appointment === "boolean") {
    set("appointment", columns.appointment?.type === "checkbox"
      ? (patch.appointment ? { checked: "true" } : null)
      : (patch.appointment ? "Yes" : "No"));
  }
  if (patch.followUp) set("followUp", textValue("followUp", truncate(patch.followUp, 5000)));
  else if (patch.followUp === null) set("followUp", textValue("followUp", ""));
  if (patch.intent) set("intent", textValue("intent", truncate(patch.intent, 2000)));
  if (patch.direction) set("direction", patch.direction);
  return values;
}

function utcDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const text = date.toISOString();
  return { date: text.slice(0, 10), time: text.slice(11, 19) };
}

function statusLabels(settings) {
  let parsed = settings;
  if (typeof settings === "string") {
    try {
      parsed = JSON.parse(settings);
    } catch {
      return [];
    }
  }
  const labels = parsed?.labels;
  if (Array.isArray(labels)) {
    return labels
      .filter((label) => !label?.is_deactivated)
      .map((label) => (typeof label === "string" ? label : label?.label ?? label?.name))
      .filter((label) => typeof label === "string" && label.trim());
  }
  if (labels && typeof labels === "object") {
    return Object.values(labels).filter((label) => typeof label === "string" && label.trim());
  }
  return [];
}

function readPhone(value) {
  if (!value) return null;
  const parsed = parseJson(value.value);
  const raw = typeof parsed?.phone === "string" && parsed.phone ? parsed.phone : value.text;
  return toE164(raw, parsed?.countryShortName || "US");
}

function readEmail(value) {
  if (!value) return null;
  const parsed = parseJson(value.value);
  return normalizeEmail(parsed?.email ?? value.text);
}

function textOf(value) {
  return typeof value?.text === "string" && value.text.trim() ? value.text.trim() : null;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function parseJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickError(errors) {
  if (!Array.isArray(errors) || !errors.length) return null;
  return errors.find((error) => error.code === CRM_ERROR.NOT_FOUND) ??
    errors.find((error) => error.code === CRM_ERROR.UNAUTHORIZED) ??
    errors[0];
}
