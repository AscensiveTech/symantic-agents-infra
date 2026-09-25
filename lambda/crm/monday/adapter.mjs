import { CRM_ERROR, CrmError } from "../errors.mjs";
import { countryForE164, nationalNumber, toE164 } from "../phone.mjs";

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

    suggestMapping,
  };

  async function queryBoards(session, ids) {
    const run = (settingsField) => graphql.request({
      accessToken: session.accessToken,
      operation: "list_boards",
      query: `query ($ids: [ID!]) {
        boards(ids: $ids, limit: 200, state: active, order_by: used_at) {
          id name
          workspace { name }
          columns { id title type ${settingsField} }
        }
      }`,
      variables: { ids },
    });
    let data;
    try {
      data = await run("settings");
    } catch (error) {
      // Older API versions only expose settings as a JSON string.
      if (!(error instanceof CrmError) || error.code !== CRM_ERROR.PROVIDER_ERROR) throw error;
      data = await run("settings_str");
    }
    return (data?.boards ?? []).map((board) => ({
      id: String(board.id),
      name: board.name,
      workspaceName: board.workspace?.name ?? null,
      columns: (board.columns ?? []).map((column) => ({
        id: column.id,
        title: column.title,
        type: column.type,
        labels: column.type === "status" ? statusLabels(column.settings ?? column.settings_str) : [],
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
