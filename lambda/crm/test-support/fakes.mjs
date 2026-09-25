// Test doubles for the CRM integration. These are behavioral fakes, not
// stubs: the Monday fake validates writes the way Monday does (unknown
// columns, missing labels, deleted items and boards, rotating refresh
// tokens, idempotency-key replay) so tests exercise real failure paths.

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// In-memory CRM store with the same conditional semantics as store.mjs.
// ---------------------------------------------------------------------------
export function createMemoryCrmStore({ now = Date.now, calls = [], profiles = {}, memberships = {} } = {}) {
  const connections = new Map();
  const links = new Map();
  const callRows = new Map(calls.map((call) => [`${call.workspaceId}\0${call.callId}`, structuredClone(call)]));
  const states = new Map();
  const writes = [];
  const key = (a, b) => `${a}\0${b}`;
  const iso = () => new Date(Number(now())).toISOString();
  const clone = (value) => (value === undefined || value === null ? value ?? null : structuredClone(value));
  const apply = (row, set) => {
    for (const [field, value] of Object.entries(set)) {
      if (value === undefined) continue;
      if (value === null) delete row[field];
      else row[field] = structuredClone(value);
    }
    return row;
  };
  const faults = new Map();
  const maybeFail = (method) => {
    const fault = faults.get(method);
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      throw fault.error;
    }
  };

  const store = {
    writes,
    connections,
    links,
    callRows,
    failNext(method, error = new Error(`${method} failed`), times = 1) {
      faults.set(method, { error, remaining: times });
    },
    seedConnection(record) {
      connections.set(key(record.workspaceId, record.provider), structuredClone(record));
    },
    seedCall(call) {
      callRows.set(key(call.workspaceId, call.callId), structuredClone(call));
    },

    async getConnection(workspaceId, provider) {
      maybeFail("getConnection");
      return clone(connections.get(key(workspaceId, provider)));
    },
    async listConnectionsByAccount(provider, accountId) {
      return [...connections.values()]
        .filter((row) => row.provider === provider && row.accountId === String(accountId))
        .map(clone);
    },
    async saveAuthorization(workspaceId, provider, record) {
      const row = connections.get(key(workspaceId, provider)) ?? { workspaceId, provider, createdAt: iso() };
      for (const field of ["refreshLockUntil", "pausedUntil", "pauseReason", "reauthReason", "disconnectedAt", "disconnectReason"]) {
        delete row[field];
      }
      apply(row, record);
      row.connectionState = "connected";
      row.tokenVersion = (row.tokenVersion ?? 0) + 1;
      row.updatedAt = iso();
      row.mappingStatus ??= row.mapping ? "unchecked" : "unconfigured";
      connections.set(key(workspaceId, provider), row);
      return clone(row);
    },
    async acquireRefreshLock(workspaceId, provider, expectedVersion, untilMs) {
      const row = connections.get(key(workspaceId, provider));
      if (!row || row.tokenVersion !== expectedVersion || row.connectionState !== "connected") return false;
      if (row.refreshLockUntil !== undefined && row.refreshLockUntil >= Number(now())) return false;
      row.refreshLockUntil = untilMs;
      return true;
    },
    async releaseRefreshLock(workspaceId, provider) {
      const row = connections.get(key(workspaceId, provider));
      if (row) delete row.refreshLockUntil;
      return clone(row);
    },
    async saveRefreshedTokens({ workspaceId, provider, expectedVersion, ...tokens }) {
      const row = connections.get(key(workspaceId, provider));
      if (!row || row.tokenVersion !== expectedVersion || row.connectionState !== "connected") return null;
      apply(row, tokens);
      row.tokenVersion += 1;
      delete row.refreshLockUntil;
      return clone(row);
    },
    async markReauthRequired(workspaceId, provider, reason) {
      const row = connections.get(key(workspaceId, provider));
      if (!row || row.connectionState !== "connected") return null;
      row.connectionState = "reauth_required";
      row.reauthReason = reason;
      delete row.refreshLockUntil;
      return clone(row);
    },
    async disconnect(workspaceId, provider, reason) {
      const row = connections.get(key(workspaceId, provider));
      if (!row) return null;
      for (const field of ["encryptedAccessToken", "encryptedRefreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "refreshLockUntil", "pausedUntil", "pauseReason"]) {
        delete row[field];
      }
      row.connectionState = "disconnected";
      row.disconnectReason = reason;
      row.disconnectedAt = iso();
      return clone(row);
    },
    async saveMapping(workspaceId, provider, mapping, { status, problems }) {
      const row = connections.get(key(workspaceId, provider));
      if (!row) return null;
      row.mapping = structuredClone(mapping);
      row.mappingStatus = status;
      row.mappingProblems = problems ?? [];
      return clone(row);
    },
    async markMappingInvalid(workspaceId, provider, problems) {
      const row = connections.get(key(workspaceId, provider));
      if (!row) return null;
      row.mappingStatus = "invalid";
      row.mappingProblems = problems;
      return clone(row);
    },
    async pause(workspaceId, provider, untilMs, reason) {
      const row = connections.get(key(workspaceId, provider));
      if (!row) return null;
      row.pausedUntil = untilMs;
      row.pauseReason = reason;
      return clone(row);
    },
    async recordSyncResult(workspaceId, provider, { status, errorCode }) {
      const row = connections.get(key(workspaceId, provider));
      if (!row) return null;
      if (status === "synced") Object.assign(row, { lastSyncAt: iso(), lastSyncStatus: status });
      else Object.assign(row, { lastErrorAt: iso(), lastErrorCode: errorCode, lastSyncStatus: status });
      return clone(row);
    },

    async getLink(workspaceId, linkKey) {
      return clone(links.get(key(workspaceId, linkKey)));
    },
    async acquireLinkLease(workspaceId, linkKey, owner, untilMs) {
      maybeFail("acquireLinkLease");
      const row = links.get(key(workspaceId, linkKey)) ?? { workspaceId, linkKey };
      if (row.leaseExpiresAt !== undefined && row.leaseExpiresAt >= Number(now()) && row.leaseOwner !== owner) {
        return null;
      }
      row.leaseOwner = owner;
      row.leaseExpiresAt = untilMs;
      links.set(key(workspaceId, linkKey), row);
      return clone(row);
    },
    async releaseLinkLease(workspaceId, linkKey, owner) {
      const row = links.get(key(workspaceId, linkKey));
      if (!row || row.leaseOwner !== owner) return null;
      delete row.leaseOwner;
      delete row.leaseExpiresAt;
      return clone(row);
    },
    async saveLink(workspaceId, linkKey, fields) {
      const row = links.get(key(workspaceId, linkKey)) ?? { workspaceId, linkKey };
      apply(row, { ...fields, updatedAt: iso() });
      links.set(key(workspaceId, linkKey), row);
      writes.push({ op: "saveLink", linkKey, fields: structuredClone(fields) });
      return clone(row);
    },
    async advanceWatermark(workspaceId, linkKey, endedAt, extra = {}) {
      const row = links.get(key(workspaceId, linkKey)) ?? { workspaceId, linkKey };
      if (row.lastAppliedEndedAt !== undefined && !(row.lastAppliedEndedAt < endedAt)) return null;
      apply(row, { lastAppliedEndedAt: endedAt, ...extra });
      links.set(key(workspaceId, linkKey), row);
      return clone(row);
    },

    async getCall(workspaceId, callId) {
      maybeFail("getCall");
      return clone(callRows.get(key(workspaceId, callId)));
    },
    async updateCallSync(workspaceId, callId, fields) {
      maybeFail("updateCallSync");
      const row = callRows.get(key(workspaceId, callId));
      if (!row) return null;
      apply(row, { ...fields, crmUpdatedAt: iso() });
      return clone(row);
    },
    async markCallQueued(workspaceId, callId, provider) {
      const row = callRows.get(key(workspaceId, callId));
      if (!row || row.crmStatus === "synced") return false;
      Object.assign(row, { crmStatus: "pending", crmProvider: provider, crmQueuedAt: iso() });
      return true;
    },
    async listFailedCalls(workspaceId, sinceIso) {
      return [...callRows.values()]
        .filter((row) => row.workspaceId === workspaceId && row.crmStatus === "failed" && (row.analyzedAt ?? "") >= sinceIso)
        .map((row) => ({ callId: row.callId, crmStatus: row.crmStatus, analyzedAt: row.analyzedAt }));
    },
    async getProfileTimezone(workspaceId) {
      return profiles[workspaceId]?.timezone ?? null;
    },
    async getMembership(userId) {
      return clone(memberships[userId]);
    },
    async putOAuthState(record) {
      if (states.has(record.state)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      states.set(record.state, structuredClone(record));
      return record;
    },
    async consumeOAuthState(state) {
      const record = states.get(state) ?? null;
      states.delete(state);
      return record;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Reversible "encryption" that still binds the ciphertext to its context,
// like KMS encryption context: decrypting with the wrong workspace fails.
// ---------------------------------------------------------------------------
export function createFakeTokenCrypto() {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    async encrypt({ plaintext, workspaceId, provider, purpose }) {
      calls.encrypt += 1;
      return Buffer.from(JSON.stringify({ plaintext, ctx: [workspaceId, provider, purpose] })).toString("base64");
    },
    async decrypt({ ciphertext, workspaceId, provider, purpose }) {
      calls.decrypt += 1;
      const value = JSON.parse(Buffer.from(ciphertext, "base64").toString("utf8"));
      if (value.ctx.join("|") !== [workspaceId, provider, purpose].join("|")) {
        throw Object.assign(new Error("Encryption context mismatch"), { name: "InvalidCiphertextException" });
      }
      return value.plaintext;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Monday (GraphQL API + OAuth 2.1 token endpoints) behind fetch.
// ---------------------------------------------------------------------------
export const TEST_APP_SECRET = Object.freeze({
  clientId: "client-123",
  clientSecret: "client-secret-abc",
  signingSecret: "signing-secret-xyz",
  appId: "10001",
});

export function createFakeMonday({ now = Date.now, accountId = "5550001" } = {}) {
  let nextId = 900_000_000;
  const id = () => String(nextId++);
  const boards = new Map();
  const items = new Map();
  const users = [
    { id: "71", name: "Sam Lee", enabled: true },
    { id: "72", name: "Priya Shah", enabled: true },
  ];
  const requests = [];
  const failures = [];
  const delays = new Map();
  const idempotencyCache = new Map();
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const revoked = [];
  let tokenCounter = 0;

  function addBoard({ name = "Leads", columns } = {}) {
    const board = {
      id: id(),
      name,
      columns: columns ?? [
        { id: "name", title: "Name", type: "name" },
        { id: "phone_mkx1", title: "Phone", type: "phone" },
        { id: "email_mkx2", title: "Email", type: "email" },
        { id: "lead_status", title: "Status", type: "status", labels: ["New Lead", "Working on it", "Follow up", "Qualified"] },
        { id: "person", title: "Owner", type: "people" },
        { id: "date_last", title: "Last call", type: "date" },
        { id: "text_outcome", title: "Call outcome", type: "text" },
        { id: "date_follow", title: "Follow-up date", type: "date" },
        { id: "date_appt", title: "Next appointment", type: "date" },
        { id: "text_source", title: "Source", type: "text" },
      ],
      deleted: false,
    };
    boards.set(board.id, board);
    return board;
  }

  function addItem(boardId, { name, phone, countryShortName = "US", email, status, owner, updatedAt }) {
    const board = boards.get(boardId);
    const values = {};
    const col = (type) => board.columns.find((column) => column.type === type)?.id;
    if (phone) values[col("phone")] = { text: phone, value: JSON.stringify({ phone, countryShortName }) };
    if (email) values[col("email")] = { text: email, value: JSON.stringify({ email, text: email }) };
    if (status) values[col("status")] = { text: status, value: JSON.stringify({ label: status }) };
    if (owner) values[col("people")] = { text: owner, value: "{}" };
    const item = {
      id: id(),
      boardId,
      name,
      state: "active",
      values,
      updates: [],
      updatedAt: updatedAt ?? new Date(Number(now())).toISOString(),
    };
    items.set(item.id, item);
    return item;
  }

  function issueTokens(authorizedAt) {
    tokenCounter += 1;
    const exp = Math.floor(Number(now()) / 1000) + 3600;
    const access = `acc.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.${tokenCounter}`;
    const refresh = `ref-${tokenCounter}`;
    accessTokens.set(access, { exp: exp * 1000 });
    refreshTokens.set(refresh, { authorizedAt, used: false });
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "me:read account:read boards:read boards:write updates:write users:read" };
  }

  const errorBody = (code, message = code, extra = {}) => ({ errors: [{ message, extensions: { code, ...extra } }] });
  const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

  function classify(query) {
    if (query.includes("items_page_by_column_values")) return "search";
    if (query.includes("create_item")) return "create_item";
    if (query.includes("create_update")) return query.includes("change_multiple_column_values") ? "log_call_and_fields" : "log_call";
    if (query.includes("updates(")) return "find_update";
    if (query.includes("items(ids")) return "get_item";
    if (query.includes("me {")) return "me";
    if (query.includes("boards(")) return "boards";
    if (query.includes("users(")) return "users";
    return "unknown";
  }

  function itemJson(item, columnIds) {
    const board = boards.get(item.boardId);
    return {
      id: item.id,
      name: item.name,
      state: item.state,
      url: `https://acme.monday.com/boards/${item.boardId}/pulses/${item.id}`,
      updated_at: item.updatedAt,
      board: { id: board.id },
      column_values: (columnIds ?? []).map((columnId) => {
        const column = board.columns.find((c) => c.id === columnId);
        const value = item.values[columnId];
        return { id: columnId, type: column?.type ?? "text", text: value?.text ?? null, value: value?.value ?? null };
      }),
    };
  }

  function validateColumnValues(board, raw) {
    const values = JSON.parse(raw);
    const out = {};
    for (const [columnId, value] of Object.entries(values)) {
      const column = board.columns.find((c) => c.id === columnId);
      if (!column) return { error: errorBody("InvalidColumnIdException", `Column ${columnId} not found`) };
      if (value === null) {
        out[columnId] = null;
        continue;
      }
      if (column.type === "status") {
        if (!column.labels.includes(value.label)) {
          return { error: errorBody("ColumnValueException", "This status label doesn't exist") };
        }
        out[columnId] = { text: value.label, value: JSON.stringify(value) };
      } else if (column.type === "phone") {
        if (!/^\+?\d{8,15}$/.test(value.phone) || !value.countryShortName) {
          return { error: errorBody("ColumnValueException", "Invalid phone") };
        }
        out[columnId] = { text: value.phone, value: JSON.stringify(value) };
      } else if (column.type === "people") {
        const personId = String(value.personsAndTeams?.[0]?.id);
        const user = users.find((u) => u.id === personId);
        if (!user) return { error: errorBody("InvalidUserIdException", "User not found") };
        out[columnId] = { text: user.name, value: JSON.stringify(value) };
      } else if (column.type === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { error: errorBody("ColumnValueException", "Bad date") };
        out[columnId] = { text: value.time ? `${value.date} ${value.time}` : value.date, value: JSON.stringify(value) };
      } else if (column.type === "email") {
        out[columnId] = { text: value.email, value: JSON.stringify(value) };
      } else if (column.type === "long_text") {
        out[columnId] = { text: value.text, value: JSON.stringify(value) };
      } else {
        out[columnId] = { text: String(value), value: JSON.stringify(String(value)) };
      }
    }
    return { values: out };
  }

  function resolveItem(itemId) {
    const item = items.get(String(itemId));
    if (!item || item.state !== "active" || boards.get(item.boardId)?.deleted) return null;
    return item;
  }

  async function handleGraphql(request, body) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const operation = classify(body.query);
    const record = { operation, idempotencyKey: request.headers.get("idempotency-key"), apiVersion: request.headers.get("api-version"), token };
    requests.push(record);

    const delay = delays.get(operation) ?? delays.get("*");
    if (delay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    const failureIndex = failures.findIndex((f) => f.operation === operation || f.operation === "*");
    if (failureIndex >= 0) {
      const failure = failures[failureIndex];
      failure.times -= 1;
      if (failure.times <= 0) failures.splice(failureIndex, 1);
      if (failure.afterEffect !== true) {
        record.failed = true;
        return response(failure.status ?? 200, failure.body, failure.headers);
      }
      // afterEffect: perform the mutation, then lose the response (a crash
      // or a network drop after Monday committed the write).
      const committed = await execute(operation, body, record);
      if (record.idempotencyKey && !committed.errors) {
        idempotencyCache.set(record.idempotencyKey, { body: committed, at: Number(now()) });
      }
      record.failed = true;
      return response(failure.status ?? 500, failure.body ?? { error_message: "Internal server error" }, failure.headers);
    }
    const tokenInfo = accessTokens.get(token);
    if (!tokenInfo || tokenInfo.exp <= Number(now()) || tokenInfo.revoked) {
      return response(401, { errors: [{ message: "Not Authenticated", extensions: { code: "Unauthorized" } }] });
    }
    if (record.idempotencyKey && idempotencyCache.has(record.idempotencyKey)) {
      const cached = idempotencyCache.get(record.idempotencyKey);
      if (Number(now()) - cached.at < 30 * 60 * 1000) {
        record.replayed = true;
        return response(200, cached.body, { "idempotency-replayed": "true" });
      }
    }
    const result = await execute(operation, body, record);
    if (record.idempotencyKey && !result.errors) {
      idempotencyCache.set(record.idempotencyKey, { body: result, at: Number(now()) });
    }
    return response(200, result);
  }

  async function execute(operation, body, record) {
    const v = body.variables ?? {};
    switch (operation) {
      case "search": {
        const board = boards.get(String(v.board));
        if (!board || board.deleted) return errorBody("InvalidBoardIdException", "Board not found");
        if (!board.columns.some((c) => c.id === v.column)) return errorBody("InvalidColumnIdException", "Column not found");
        const needle = String(v.value).replace(/\D/g, "") || String(v.value).toLowerCase();
        const matches = [...items.values()].filter((item) => {
          if (item.boardId !== board.id || item.state !== "active") return false;
          const text = item.values[v.column]?.text ?? "";
          const column = board.columns.find((c) => c.id === v.column);
          return column.type === "phone" ? text.replace(/\D/g, "").includes(needle) : text.toLowerCase() === String(v.value).toLowerCase();
        });
        return { data: { items_page_by_column_values: { cursor: null, items: matches.map((item) => itemJson(item, v.columns)) } } };
      }
      case "get_item": {
        const item = items.get(String(v.ids?.[0]));
        return { data: { items: item && !boards.get(item.boardId)?.deleted ? [itemJson(item, v.columns)] : [] } };
      }
      case "find_update": {
        const item = resolveItem(v.ids?.[0]);
        return { data: { items: item ? [{ id: item.id, updates: item.updates.map((u) => ({ id: u.id, text_body: u.text })) }] : [] } };
      }
      case "create_item": {
        const board = boards.get(String(v.board));
        if (!board || board.deleted) return errorBody("InvalidBoardIdException", "Board not found");
        const checked = validateColumnValues(board, v.values);
        if (checked.error) return checked.error;
        const item = {
          id: id(),
          boardId: board.id,
          name: v.name,
          state: "active",
          values: Object.fromEntries(Object.entries(checked.values).filter(([, value]) => value)),
          updates: [],
          updatedAt: new Date(Number(now())).toISOString(),
        };
        items.set(item.id, item);
        record.createdItemId = item.id;
        return { data: { create_item: { id: item.id, name: item.name, url: `https://acme.monday.com/boards/${board.id}/pulses/${item.id}` } } };
      }
      case "log_call":
      case "log_call_and_fields": {
        const item = resolveItem(v.item);
        const data = {};
        const errors = [];
        if (operation === "log_call_and_fields") {
          const board = boards.get(String(v.board));
          if (!board || board.deleted) {
            data.fields = null;
            errors.push({ message: "Board not found", path: ["fields"], extensions: { code: "InvalidBoardIdException" } });
          } else if (!item) {
            data.fields = null;
            errors.push({ message: "Item not found", path: ["fields"], extensions: { code: "InvalidItemIdException", error_data: { item_id: v.item } } });
          } else {
            const checked = validateColumnValues(board, v.values);
            if (checked.error) {
              data.fields = null;
              errors.push({ ...checked.error.errors[0], path: ["fields"] });
            } else {
              for (const [columnId, value] of Object.entries(checked.values)) {
                if (value === null) delete item.values[columnId];
                else item.values[columnId] = value;
              }
              item.updatedAt = new Date(Number(now())).toISOString();
              data.fields = { id: item.id };
            }
          }
        }
        if (!item) {
          data.note = null;
          errors.push({ message: "Item not found", path: ["note"], extensions: { code: "InvalidItemIdException", error_data: { item_id: v.item } } });
        } else {
          const update = { id: id(), text: v.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), html: v.body };
          item.updates.unshift(update);
          data.note = { id: update.id };
        }
        return errors.length ? { data, errors } : { data };
      }
      case "me":
        return { data: { me: { id: "71", name: "Sam Lee", email: "sam@acme.test", account: { id: accountId, name: "Acme Dental", slug: "acme" } } } };
      case "boards": {
        const wanted = v.ids ? v.ids.map(String) : null;
        const list = [...boards.values()].filter((board) => !board.deleted && (!wanted || wanted.includes(board.id)));
        return {
          data: {
            boards: list.map((board) => ({
              id: board.id,
              name: board.name,
              workspace: { name: "Sales" },
              columns: board.columns.map((column) => ({
                id: column.id,
                title: column.title,
                type: column.type,
                settings: column.type === "status"
                  ? { labels: column.labels.map((label, index) => ({ id: index, label })) }
                  : {},
              })),
            })),
          },
        };
      }
      case "users":
        return { data: { users } };
      default:
        return errorBody("InvalidArgumentException", "Unknown query");
    }
  }

  async function handleToken(body) {
    requests.push({ operation: `oauth_${body.grant_type}` });
    const failureIndex = failures.findIndex((f) => f.operation === "token");
    if (failureIndex >= 0) {
      const failure = failures[failureIndex];
      failure.times -= 1;
      if (failure.times <= 0) failures.splice(failureIndex, 1);
      return response(failure.status, failure.body ?? {});
    }
    if (body.client_id !== TEST_APP_SECRET.clientId || body.client_secret !== TEST_APP_SECRET.clientSecret) {
      return response(401, { error: "invalid_client" });
    }
    if (body.grant_type === "authorization_code") {
      const code = codes.get(body.code);
      codes.delete(body.code);
      if (!code || code.redirectUri !== body.redirect_uri) return response(400, { error: "invalid_grant" });
      const verifierHash = await sha256Base64Url(body.code_verifier ?? "");
      if (verifierHash !== code.challenge) return response(400, { error: "invalid_grant", error_description: "PKCE" });
      return response(200, issueTokens(Number(now())));
    }
    if (body.grant_type === "refresh_token") {
      const info = refreshTokens.get(body.refresh_token);
      if (!info || info.used || info.revoked) return response(400, { error: "invalid_grant" });
      info.used = true; // rotation: a refresh token works exactly once
      return response(200, issueTokens(info.authorizedAt));
    }
    return response(400, { error: "unsupported_grant_type" });
  }

  const fetchImpl = async (url, init = {}) => {
    const request = new Request(url, init);
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === "https://api.monday.com/v2") return handleGraphql(request, body);
    if (url === "https://auth.monday.com/oauth_ms/oauth/token") return handleToken(body);
    if (url === "https://auth.monday.com/oauth_ms/oauth/revoke") {
      requests.push({ operation: "oauth_revoke" });
      const failureIndex = failures.findIndex((f) => f.operation === "revoke");
      if (failureIndex >= 0) {
        failures.splice(failureIndex, 1);
        return response(503, {});
      }
      revoked.push(body.token);
      const info = refreshTokens.get(body.token);
      if (info) info.revoked = true;
      return response(200, {});
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  return {
    fetchImpl,
    boards,
    items,
    users,
    requests,
    revoked,
    addBoard,
    addItem,
    /** Pre-authorize: the user approved consent for this PKCE challenge. */
    issueCode({ redirectUri, challenge }) {
      const code = `code-${codes.size + 1}-${tokenCounter}`;
      codes.set(code, { redirectUri, challenge });
      return code;
    },
    issueTokens,
    expireAccessTokens() {
      for (const info of accessTokens.values()) info.exp = 0;
    },
    revokeAll() {
      for (const info of accessTokens.values()) info.revoked = true;
      for (const info of refreshTokens.values()) info.revoked = true;
    },
    failNext(operation, { status = 200, body, headers, times = 1, afterEffect = false } = {}) {
      failures.push({ operation, status, body, headers, times, afterEffect });
    },
    clearFailures() {
      failures.length = 0;
    },
    delay(operation, ms) {
      if (ms) delays.set(operation, ms);
      else delays.delete(operation);
    },
    count(operation) {
      return requests.filter((r) => !operation || r.operation === operation).length;
    },
    graphqlCount() {
      return requests.filter((r) => !r.operation.startsWith("oauth_")).length;
    },
    reset() {
      requests.length = 0;
    },
    deleteItem(itemId) {
      const item = items.get(String(itemId));
      if (item) item.state = "deleted";
    },
    deleteBoard(boardId) {
      const board = boards.get(String(boardId));
      if (board) board.deleted = true;
    },
    removeColumn(boardId, columnId) {
      const board = boards.get(String(boardId));
      board.columns = board.columns.filter((column) => column.id !== columnId);
    },
    errorBody,
  };
}

async function sha256Base64Url(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("base64url");
}

/** Sign a lifecycle-webhook JWT the way Monday does (HS256). */
export function signJwt(claims, secret, header = { alg: "HS256", typ: "JWT" }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode(header);
  const body = encode(claims);
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// SQS simulator: visibility timeouts, receive counts, redrive to a DLQ.
// ---------------------------------------------------------------------------
export function createFakeQueue({ now = Date.now, maxReceiveCount = 8, defaultVisibility = 360 } = {}) {
  const messages = [];
  const dlq = [];
  let counter = 0;
  return {
    messages,
    dlq,
    send(body) {
      counter += 1;
      messages.push({ messageId: `m-${counter}`, body: JSON.stringify(body), sentAt: Number(now()), visibleAt: 0, receiveCount: 0, receipt: null });
    },
    changeVisibility: async (receiptHandle, seconds) => {
      const message = messages.find((m) => m.receipt === receiptHandle);
      if (!message) throw new Error("ReceiptHandleIsInvalid");
      message.visibleAt = Number(now()) + seconds * 1000;
    },
    /** Receive up to `max` visible messages as a Lambda SQS event. */
    receive(max = 5) {
      const records = [];
      for (const message of [...messages]) {
        if (records.length >= max) break;
        if (message.visibleAt > Number(now())) continue;
        if (message.receiveCount >= maxReceiveCount) {
          messages.splice(messages.indexOf(message), 1);
          dlq.push(message);
          continue;
        }
        message.receiveCount += 1;
        message.receipt = `r-${message.messageId}-${message.receiveCount}`;
        message.visibleAt = Number(now()) + defaultVisibility * 1000;
        records.push({
          messageId: message.messageId,
          receiptHandle: message.receipt,
          body: message.body,
          attributes: { ApproximateReceiveCount: String(message.receiveCount), SentTimestamp: String(message.sentAt) },
        });
      }
      return { Records: records };
    },
    /** Apply the Lambda's batch response: delete successes. */
    settle(event, result) {
      const failed = new Set((result?.batchItemFailures ?? []).map((f) => f.itemIdentifier));
      for (const record of event.Records) {
        if (failed.has(record.messageId)) continue;
        const index = messages.findIndex((m) => m.messageId === record.messageId);
        if (index >= 0) messages.splice(index, 1);
      }
    },
  };
}

export function createClock(start = Date.parse("2026-09-25T15:00:00.000Z")) {
  let current = start;
  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
  };
  clock.set = (value) => {
    current = value;
  };
  return clock;
}
