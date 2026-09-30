import { randomBytes } from "node:crypto";
import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { FIELD_TYPES, suggestMapping } from "./monday/adapter.mjs";
import { buildAuthorizeUrl, buildInstallUrl, createPkcePair, verifyMondayJwt } from "./monday/oauth.mjs";
import { agentIdOf, connectionKeyFor, isConnectionUsable, providerIdOf } from "./provider.mjs";
import { createRequeuer } from "./requeue.mjs";

const PROVIDER = "monday";
const OAUTH_STATE_PROVIDER = "monday-crm";
const STATE_TTL_SECONDS = 600;
const ADMIN_ROLES = new Set(["company-admin", "super-admin"]);
const DEFAULT_RETURN_TO = "/integrations";

class ApiError extends Error {
  // statusCode and code go to the client as-is; extra adds fields such as
  // per-field mapping problems.
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Settings API for the CRM connection (JWT-authorized, except the OAuth
 * callback and Monday's lifecycle webhook, which verify themselves).
 */
export function createCrmApi({
  store,
  adapter,
  oauthClient,
  sessions,
  tokenCrypto,
  getAppSecret,
  enqueue,
  metrics,
  appUrl,
  apiBaseUrl,
  now = Date.now,
  randomState = () => randomBytes(32).toString("base64url"),
  log = console,
}) {
  // The OAuth redirect URI registered with Monday; it must match exactly on
  // both legs of the flow.
  const callbackUri = () => `${String(apiBaseUrl).replace(/\/+$/, "")}/crm/oauth/monday/callback`;

  // The signed-in user and their workspace, or 401. admin: true also requires
  // a workspace admin (403 otherwise).
  async function requireIdentity(event, { admin = false } = {}) {
    const identity = await resolveIdentity(event, store);
    if (!identity) throw new ApiError(401, "unauthorized", "Unauthorized");
    if (admin && !identity.roles.some((role) => ADMIN_ROLES.has(role))) {
      throw new ApiError(403, "forbidden", "Only a workspace administrator can manage the CRM connection");
    }
    return identity;
  }

  // Every CRM connection belongs to one agent. The agentId comes from the
  // request, so it is only trusted after checking the agent is an active
  // agent in the caller's own workspace.
  async function requireAgentKey(identity, event) {
    const agentId = readAgentId(event);
    if (!agentId) throw new ApiError(400, "invalid_request", "Choose an agent first.");
    const agent = await store.getAgent(identity.workspaceId, agentId);
    if (!agent || agent.status === "deleted") throw new ApiError(404, "agent_not_found", "That agent no longer exists.");
    return connectionKeyFor(PROVIDER, agentId);
  }

  // Runs a Monday request with this agent's connection, turning an expired
  // grant or an inactive account into the right 409 for the card.
  async function requireUsableSession(workspaceId, key, operation) {
    const connection = await store.getConnection(workspaceId, key);
    if (!connection || connection.connectionState === "disconnected") {
      throw new ApiError(409, "not_connected", "Connect Monday first.");
    }
    try {
      return await sessions.withSession(connection, operation);
    } catch (error) {
      if (error instanceof CrmError) {
        if (error.code === CRM_ERROR.REAUTH_REQUIRED || error.code === CRM_ERROR.NOT_CONNECTED) {
          throw new ApiError(409, "reauth_required", "Monday authorization expired. Reconnect to continue.");
        }
        if (error.code === CRM_ERROR.ACCOUNT_INACTIVE) {
          throw new ApiError(409, "account_inactive", "Monday says this account is inactive (suspended, closed or unpaid). Reactivate it in Monday, then try again.");
        }
        if (error.retryable) {
          throw new ApiError(503, error.code, "Monday is not responding right now. Try again shortly.", {
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        throw new ApiError(502, error.code, "Monday rejected the request.");
      }
      throw error;
    }
  }

  // Re-send every recently failed call once the admin has fixed whatever
  // made it fail (reconnected, or corrected the mapping).
  const requeueFailed = createRequeuer({ store, enqueue, metrics, now });

  // The "Symantic AI Calls" board is created as soon as an agent connects,
  // but NOT inside this request: creating it takes ~15 sequential Monday
  // calls, which overran the callback's time budget (the customer saw
  // "Service Unavailable" instead of being sent back). The sync worker
  // builds it moments later; if even that fails, the first call does.
  async function queueCallsBoard(connection) {
    if (connection.callsBoard?.status === "active" && connection.callsBoard.id) return;
    // A board deleted in Monday waits for the admin's Recreate Board.
    if (connection.callsBoard?.status === "deleted" || connection.callsBoardEnabled === false) return;
    try {
      await enqueue({ kind: "ensure-calls-board", workspaceId: connection.workspaceId, provider: connection.provider });
    } catch (error) {
      log.warn?.("Calls board not queued at connect", { workspaceId: connection.workspaceId, ...describeError(error) });
    }
  }

  // Re-checks the saved mapping against the board as it is in Monday now
  // (columns can be deleted there) and saves the result.
  async function revalidate(workspaceId, connection) {
    if (!connection?.mapping) return connection;
    try {
      const outcome = await sessions.withSession(connection, (session) =>
        adapter.validateMapping(session, connection.mapping)
      );
      return await store.saveMapping(workspaceId, connection.provider, connection.mapping, {
        status: outcome.ok ? "valid" : "invalid",
        problems: outcome.problems,
      }) ?? connection;
    } catch (error) {
      log.warn?.("CRM mapping revalidation failed", { workspaceId, ...describeError(error) });
      return connection;
    }
  }

  // Revoke at Monday (best effort - the grant dies with our copy either way)
  // and delete our tokens.
  async function disconnectConnection(connection, reason) {
    if (connection.encryptedRefreshToken) {
      try {
        const refreshToken = await tokenCrypto.decrypt({
          ciphertext: connection.encryptedRefreshToken,
          workspaceId: connection.workspaceId,
          provider: PROVIDER,
          purpose: "refresh",
        });
        await oauthClient.revoke({ token: refreshToken, hint: "refresh_token" });
      } catch (error) {
        log.warn?.("Monday token revoke failed; deleting local tokens anyway", describeError(error));
      }
    }
    return store.disconnect(connection.workspaceId, connection.provider, reason);
  }

  // Called (direct invoke) while an agent is being deleted. Never throws;
  // "done" only after re-reading the row shows no tokens left.
  async function disconnectAgent({ workspaceId, agentId }) {
    if (typeof workspaceId !== "string" || !workspaceId || typeof agentId !== "string" || !agentId) {
      return { status: "failed", code: "invalid_request" };
    }
    try {
      const key = connectionKeyFor(PROVIDER, agentId);
      const connection = await store.getConnection(workspaceId, key);
      if (!connection || connection.connectionState === "disconnected") return { status: "none" };
      await disconnectConnection(connection, "agent_deleted");
      const after = await store.getConnection(workspaceId, key);
      if (after?.connectionState !== "disconnected" || after.encryptedRefreshToken || after.encryptedAccessToken) {
        return { status: "failed", code: "not_cleared" };
      }
      log.info?.("CRM disconnected for agent deletion", { workspaceId, agentId });
      return { status: "done", accountName: connection.accountName ?? null };
    } catch (error) {
      log.error?.("CRM disconnect for agent deletion failed", { workspaceId, ...describeError(error) });
      return { status: "failed", code: "unexpected" };
    }
  }

  const routes = {
    async "GET /crm/connection"(event) {
      const identity = await requireIdentity(event);
      const key = await requireAgentKey(identity, event);
      const connection = await store.getConnection(identity.workspaceId, key);
      return json(200, toPublicConnection(connection, now));
    },

    async "GET /crm/monday/setup"(event) {
      await requireIdentity(event, { admin: true });
      const secret = await loadAppSecret(getAppSecret);
      return json(200, { installUrl: buildInstallUrl({ clientId: secret.clientId }) });
    },

    async "POST /crm/monday/start"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const body = readBody(event);
      const key = await requireAgentKey(identity, event);
      const secret = await loadAppSecret(getAppSecret);
      const { verifier, challenge } = createPkcePair();
      const state = randomState();
      await store.putOAuthState({
        state,
        provider: OAUTH_STATE_PROVIDER,
        workspaceId: identity.workspaceId,
        agentId: agentIdOf(key),
        userId: identity.userId,
        displayName: identity.displayName,
        codeVerifier: verifier,
        redirectUri: callbackUri(),
        returnTo: sanitizeReturnTo(body?.returnTo),
        expiresAt: Math.floor(Number(now()) / 1000) + STATE_TTL_SECONDS,
      });
      return json(200, {
        authorizeUrl: buildAuthorizeUrl({
          clientId: secret.clientId,
          redirectUri: callbackUri(),
          state,
          codeChallenge: challenge,
        }),
      });
    },

    async "GET /crm/oauth/monday/callback"(event) {
      const query = event?.queryStringParameters ?? {};
      // Sends the browser back to the app page it started from, with the
      // outcome in the query string.
      const back = (returnTo, params) => redirect(buildAppRedirect(appUrl, returnTo, params));
      const stateRecord = typeof query.state === "string" && query.state
        ? await store.consumeOAuthState(query.state)
        : null;
      if (
        !stateRecord ||
        stateRecord.provider !== OAUTH_STATE_PROVIDER ||
        stateRecord.redirectUri !== callbackUri() ||
        Number(stateRecord.expiresAt) * 1000 < Number(now()) ||
        !stateRecord.agentId
      ) {
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "invalid_state" });
        return back(DEFAULT_RETURN_TO, { crm: "error", reason: "invalid_state" });
      }
      if (query.error || typeof query.code !== "string" || !query.code) {
        // access_denied is the user pressing Cancel; anything else is Monday
        // refusing (commonly: this Monday user may not install apps).
        const cancelled = !query.error || query.error === "access_denied";
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: cancelled ? "denied" : "monday_error" });
        return back(stateRecord.returnTo, { crm: "error", reason: cancelled ? "authorization_denied" : "install_not_allowed" });
      }
      const { workspaceId } = stateRecord;
      const key = connectionKeyFor(PROVIDER, stateRecord.agentId);
      try {
        const tokens = await oauthClient.exchangeCode({
          code: query.code,
          redirectUri: stateRecord.redirectUri,
          codeVerifier: stateRecord.codeVerifier,
        });
        const account = await adapter.describeAccount({ accessToken: tokens.accessToken, mapping: null });
        // Tokens are swapped only after everything above succeeded, so a
        // failed renewal leaves the working connection untouched.
        const previous = await store.getConnection(workspaceId, key);
        const switchedAccount = Boolean(previous?.accountId && account.accountId &&
          String(previous.accountId) !== String(account.accountId));
        const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
          tokenCrypto.encrypt({ plaintext: tokens.accessToken, workspaceId, provider: PROVIDER, purpose: "access" }),
          tokenCrypto.encrypt({ plaintext: tokens.refreshToken, workspaceId, provider: PROVIDER, purpose: "refresh" }),
        ]);
        let connection = await store.saveAuthorization(workspaceId, key, {
          agentId: stateRecord.agentId,
          accountId: account.accountId,
          accountName: account.accountName,
          accountSlug: account.accountSlug,
          mondayUserId: account.userId,
          mondayUserName: account.userName,
          authorizedBy: stateRecord.userId,
          authorizedByName: stateRecord.displayName,
          authorizedAt: new Date(Number(now())).toISOString(),
          scopes: tokens.scopes,
          encryptedAccessToken,
          encryptedRefreshToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        });
        if (switchedAccount) {
          // Renewed with a different Monday account: the saved board lives in
          // the old one. Keep the mapping (switching back fixes it) but flag
          // it, and log calls to a board in the account now connected.
          await store.saveCallsBoard(workspaceId, key, null);
          connection = await store.markMappingInvalid(workspaceId, key, [{
            field: "board",
            code: "account_changed",
            message: `You renewed with a different Monday account (${account.accountName ?? account.accountId}). Renew again with ${previous.accountName ?? "the original account"}, or choose a board from this account.`,
          }]) ?? connection;
          connection = await store.getConnection(workspaceId, key) ?? connection;
          metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "account_changed" });
        } else {
          connection = await revalidate(workspaceId, connection);
        }
        await queueCallsBoard(connection);
        // Reconnecting after a disconnect: calls taken meanwhile were never
        // queued. Send only those (each checked by Call ID, so nothing already
        // on the board is added again).
        if (previous?.connectionState === "disconnected" && previous.disconnectedAt) {
          await enqueue({ kind: "catch-up", workspaceId, provider: key, since: previous.disconnectedAt })
            .catch((error) => log.warn?.("Reconnect catch-up not queued", { workspaceId, ...describeError(error) }));
        }
        if (connection.connectionState === "connected") await requeueFailed(workspaceId, key);
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "connected" });
        log.info?.("CRM connected", { workspaceId, agentId: stateRecord.agentId, accountId: account.accountId });
        return back(stateRecord.returnTo, { crm: "connected" });
      } catch (error) {
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "failed" });
        log.error?.("CRM OAuth callback failed", { workspaceId, ...describeError(error) });
        return back(stateRecord.returnTo, { crm: "error", reason: "connection_failed" });
      }
    },

    async "DELETE /crm/connection"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      const connection = await store.getConnection(identity.workspaceId, key);
      if (!connection) return json(200, null);
      const saved = await disconnectConnection(connection, "user_disconnected");
      log.info?.("CRM disconnected", { workspaceId: identity.workspaceId, agentId: agentIdOf(key), by: identity.userId });
      return json(200, toPublicConnection(saved, now));
    },

    async "GET /crm/monday/boards"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      const { boards, users } = await requireUsableSession(identity.workspaceId, key, async (session) => ({
        boards: await adapter.listBoards(session),
        users: await adapter.listUsers(session),
      }));
      const connection = await store.getConnection(identity.workspaceId, key);
      const callsBoardId = connection?.callsBoard?.id ? String(connection.callsBoard.id) : null;
      return json(200, {
        // The agent's own calls board is ours - never offered for mapping.
        boards: boards.filter((board) => String(board.id) !== callsBoardId).map((board) => ({
          ...board,
          hasPhoneColumn: board.columns.some((column) => column.type === "phone"),
          suggestion: suggestMapping(board),
        })),
        users,
        fieldTypes: FIELD_TYPES,
      });
    },

    async "POST /crm/monday/columns"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const body = readBody(event);
      const boardId = typeof body?.boardId === "string" || typeof body?.boardId === "number"
        ? String(body.boardId).trim() : "";
      if (!/^\d{1,20}$/.test(boardId)) throw new ApiError(400, "invalid_request", "Invalid board ID.");
      const title = typeof body?.title === "string" ? body.title.trim().slice(0, 100) : "";
      if (!title) throw new ApiError(400, "invalid_request", "Column title is required.");
      const columnType = typeof body?.columnType === "string" ? body.columnType : "";
      const allowed = new Set(["phone", "email", "status", "people", "date", "text", "long_text", "numbers", "link"]);
      if (!allowed.has(columnType)) throw new ApiError(400, "invalid_request", `Invalid column type: ${columnType}`);
      const key = await requireAgentKey(identity, event);
      const column = await requireUsableSession(identity.workspaceId, key, async (session) => {
        const data = await adapter.createColumn(session, boardId, title, columnType);
        return data;
      });
      return json(200, column);
    },

    async "PUT /crm/mapping"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const requested = normalizeMappingInput(readBody(event)?.mapping);
      const key = await requireAgentKey(identity, event);
      const outcome = await requireUsableSession(identity.workspaceId, key, (session) =>
        adapter.validateMapping(session, requested)
      );
      if (!outcome.ok) {
        return json(422, { error: "mapping_invalid", message: "The mapping needs changes.", problems: outcome.problems });
      }
      // Types and titles come from the live board, never from the request.
      const columnsById = new Map(outcome.board.columns.map((column) => [column.id, column]));
      const mapping = {
        ...requested,
        boardName: outcome.board.name,
        columns: Object.fromEntries(Object.entries(requested.columns).map(([field, { id }]) => {
          const column = columnsById.get(id);
          return [field, { id, type: column.type, title: column.title }];
        })),
      };
      await store.saveMapping(identity.workspaceId, key, mapping, { status: "valid", problems: [] });
      // Saving a board mapping is choosing to sync to that board.
      const saved = await store.setBoardSyncEnabled(identity.workspaceId, key, true);
      const requeued = await requeueFailed(identity.workspaceId, key);
      log.info?.("CRM mapping saved", { workspaceId: identity.workspaceId, agentId: agentIdOf(key), requeued });
      return json(200, { ...toPublicConnection(saved, now), requeued });
    },

    // Turn syncing to one of the customer's own boards on or off. The calls
    // board always logs; the saved mapping is kept either way.
    async "PUT /crm/board-sync"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      const enabled = readBody(event)?.enabled;
      if (typeof enabled !== "boolean") throw new ApiError(400, "invalid_request", "enabled must be true or false.");
      const connection = await store.getConnection(identity.workspaceId, key);
      if (!connection || connection.connectionState === "disconnected") {
        throw new ApiError(409, "not_connected", "Connect Monday first.");
      }
      const saved = await store.setBoardSyncEnabled(identity.workspaceId, key, enabled);
      log.info?.("CRM board sync toggled", { workspaceId: identity.workspaceId, agentId: agentIdOf(key), enabled });
      return json(200, toPublicConnection(saved, now));
    },

    // "Check Again" on the card after the customer reactivates their Monday
    // account: if Monday answers, logging resumes and missed calls replay.
    async "POST /crm/check-account"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      await requireUsableSession(identity.workspaceId, key, (session) => adapter.describeAccount(session));
      await store.clearPause(identity.workspaceId, key);
      const requeued = await requeueFailed(identity.workspaceId, key);
      const saved = await store.getConnection(identity.workspaceId, key);
      log.info?.("CRM account check passed", { workspaceId: identity.workspaceId, agentId: agentIdOf(key), requeued });
      return json(200, { ...toPublicConnection(saved, now), requeued });
    },

    // The auto-created calls board, from the Monday card:
    //   recreate - after it was deleted in Monday: build a new board and put
    //              the agent's full call history on it;
    //   stop     - stop logging to a calls board for this agent;
    //   start    - turn it back on (builds or reuses the board, then adds
    //              every call it's missing).
    // Building happens in the worker; this only records the choice and queues it.
    async "POST /crm/calls-board"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      const action = readBody(event)?.action;
      if (!["recreate", "stop", "start"].includes(action)) {
        throw new ApiError(400, "invalid_request", "action must be recreate, stop or start.");
      }
      const connection = await store.getConnection(identity.workspaceId, key);
      if (connection?.connectionState !== "connected") throw new ApiError(409, "not_connected", "Connect Monday first.");
      if (action === "stop") {
        const saved = await store.setCallsBoardEnabled(identity.workspaceId, key, false);
        log.info?.("Calls board turned off", { workspaceId: identity.workspaceId, agentId: agentIdOf(key) });
        return json(200, toPublicConnection(saved, now));
      }
      await store.setCallsBoardEnabled(identity.workspaceId, key, true);
      await enqueue({
        kind: "ensure-calls-board",
        workspaceId: identity.workspaceId,
        provider: key,
        recreate: connection.callsBoard?.status === "deleted",
        rebuild: true,
      });
      log.info?.("Calls board rebuild queued", { workspaceId: identity.workspaceId, agentId: agentIdOf(key), action });
      const saved = await store.getConnection(identity.workspaceId, key);
      return json(200, { ...toPublicConnection(saved, now), callsBoardQueued: true });
    },

    async "POST /crm/sync/retry"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const key = await requireAgentKey(identity, event);
      const connection = await store.getConnection(identity.workspaceId, key);
      if (!isConnectionUsable(connection)) {
        throw new ApiError(409, "not_ready", "Finish connecting Monday before retrying.");
      }
      return json(200, { requeued: await requeueFailed(identity.workspaceId, key) });
    },

    async "POST /crm/monday/lifecycle"(event) {
      const secret = await loadAppSecret(getAppSecret);
      const authorization = readHeader(event?.headers, "authorization");
      const claims = verifyMondayJwt(authorization, secret.clientSecret, { now });
      const body = readBody(event);
      if (!claims || !body) {
        metrics?.count("Webhook", { Provider: PROVIDER, Outcome: "rejected" });
        return json(401, { message: "Unauthorized" });
      }
      const accountId = String(body?.data?.account_id ?? "");
      const claimedAccount = claims.accountId ?? claims.account_id ?? claims.dat?.account_id;
      const claimedApp = claims.appId ?? claims.app_id ?? claims.dat?.app_id;
      if (
        !accountId ||
        (claimedAccount !== undefined && String(claimedAccount) !== accountId) ||
        (secret.appId && claimedApp !== undefined && String(claimedApp) !== String(secret.appId))
      ) {
        metrics?.count("Webhook", { Provider: PROVIDER, Outcome: "rejected" });
        return json(401, { message: "Unauthorized" });
      }
      metrics?.count("Webhook", { Provider: PROVIDER, Outcome: String(body.type ?? "unknown") });
      if (body.type === "uninstall") {
        const connections = await store.listConnectionsByAccount(PROVIDER, accountId);
        for (const connection of connections) {
          await store.purgeProviderData(connection.workspaceId, connection.provider);
        }
        log.info?.("Monday app uninstalled", { accountId, purged: connections.length });
      }
      return json(200, { ok: true });
    },
  };

  // Routes an API Gateway request to its handler. ApiError becomes its own
  // status; anything else is logged and returned as a plain 500.
  async function handleApi(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
    const route = routes[`${method} ${path}`];
    if (!route) return json(404, { message: "Not found" });
    try {
      return await route(event);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(error.statusCode, { error: error.code, message: error.message, ...error.extra });
      }
      log.error?.("CRM API request failed", { path, ...describeError(error) });
      return json(500, { error: "internal_error", message: "The request could not be completed." });
    }
  }
  handleApi.disconnectAgent = disconnectAgent;
  return handleApi;
}

// Plain-language status of the auto-created calls board.
const CALLS_BOARD_MESSAGES = {
  forbidden: "Your Monday user isn't allowed to create boards. Ask your Monday.com account administrator for permission, then reconnect.",
  board_limit: "Your Monday plan has reached its board limit. Free up a board or upgrade your Monday plan, then reconnect.",
  unavailable: "Monday was unavailable when we tried to create the call log board. It will be created with the next call.",
  failed: "We couldn't create the call log board. It will be tried again with the next call.",
};

// The calls board as the card sees it: link, status, and a plain-language
// message when it failed or was deleted.
function publicCallsBoard(connection) {
  const board = connection.callsBoard;
  if (!board) return null;
  if (board.status === "deleted") {
    return {
      id: null,
      status: "deleted",
      url: null,
      message: "Your \u201cSymantic AI Calls\u201d board was deleted in Monday. Calls are still answered and kept in Call History; they'll be added to Monday once you recreate the board.",
      deletedAt: board.deletedAt ?? null,
    };
  }
  const active = board.status === "active" && board.id;
  return {
    id: active ? String(board.id) : null,
    status: active ? "active" : "failed",
    url: active && connection.accountSlug ? `https://${connection.accountSlug}.monday.com/boards/${board.id}` : null,
    message: active ? null : CALLS_BOARD_MESSAGES[board.errorCode] ?? CALLS_BOARD_MESSAGES.failed,
  };
}

// The browser-safe view of a connection: status, mapping and sync health
// only, never tokens.
function toPublicConnection(connection, now = Date.now) {
  if (!connection) return null;
  const refreshExpiry = Number(connection.refreshTokenExpiresAt);
  const paused = Number(connection.pausedUntil) > Number(now());
  return {
    provider: providerIdOf(connection.provider),
    agentId: connection.agentId ?? agentIdOf(connection.provider),
    connectionState: connection.connectionState,
    accountName: connection.accountName ?? null,
    accountSlug: connection.accountSlug ?? null,
    connectedAs: connection.mondayUserName ?? null,
    authorizedByName: connection.authorizedByName ?? null,
    authorizedAt: connection.authorizedAt ?? null,
    reauthorizeBy: Number.isFinite(refreshExpiry) && refreshExpiry > 0 && connection.connectionState === "connected"
      ? new Date(refreshExpiry).toISOString()
      : null,
    reauthReason: connection.reauthReason ?? null,
    mappingStatus: connection.mappingStatus ?? "unconfigured",
    boardSyncEnabled: connection.boardSyncEnabled !== false,
    callsBoardEnabled: connection.callsBoardEnabled !== false,
    callsBoard: publicCallsBoard(connection),
    mapping: connection.mapping ?? null,
    mappingProblems: connection.mappingProblems ?? [],
    pausedUntil: paused ? new Date(Number(connection.pausedUntil)).toISOString() : null,
    pauseReason: paused ? connection.pauseReason ?? null : null,
    lastSyncAt: connection.lastSyncAt ?? null,
    lastSyncStatus: connection.lastSyncStatus ?? null,
    lastErrorCode: connection.lastErrorCode ?? null,
    lastErrorAt: connection.lastErrorAt ?? null,
    disconnectedAt: connection.disconnectedAt ?? null,
    disconnectReason: connection.disconnectReason ?? null,
  };
}

// Validates and trims a mapping sent from the browser: numeric ids only,
// known fields only, bounded labels.
function normalizeMappingInput(value) {
  if (!value || typeof value !== "object") {
    throw new ApiError(400, "invalid_request", "A mapping is required");
  }
  const boardId = typeof value.boardId === "string" || typeof value.boardId === "number"
    ? String(value.boardId).trim()
    : "";
  if (!/^\d{1,20}$/.test(boardId)) throw new ApiError(400, "invalid_request", "Choose a board.");
  const columns = {};
  for (const field of Object.keys(FIELD_TYPES)) {
    const id = value.columns?.[field]?.id ?? value.columns?.[field];
    if (typeof id === "string" && /^[A-Za-z0-9_]{1,64}$/.test(id)) columns[field] = { id };
  }
  // A status label, trimmed and capped, or null.
  const label = (text) => (typeof text === "string" && text.trim() ? text.trim().slice(0, 100) : null);
  const owner = value.defaultOwnerId === null || value.defaultOwnerId === undefined || value.defaultOwnerId === ""
    ? null
    : String(value.defaultOwnerId);
  if (owner !== null && !/^\d{1,20}$/.test(owner)) throw new ApiError(400, "invalid_request", "Invalid default owner.");
  return {
    boardId,
    columns,
    labels: { newLead: label(value.labels?.newLead), followUp: label(value.labels?.followUp) },
    defaultOwnerId: owner,
  };
}

// Who is calling, from the Cognito JWT claims, plus their workspace
// membership. Null when not signed in or not an active member.
async function resolveIdentity(event, store) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (typeof sub !== "string" || !sub) return null;
  const userId = claims?.username ?? claims?.["cognito:username"] ?? claims?.email ?? sub;
  const roles = claimGroups(claims?.["cognito:groups"]);
  const displayName = typeof claims?.name === "string" && claims.name.trim() ? claims.name.trim() : userId;
  const membership = await store.getMembership(sub);
  if (!membership || membership.status === "disabled") return null;
  if (typeof membership.workspaceId !== "string" || !membership.workspaceId) return null;
  return { workspaceId: membership.workspaceId, userId, roles, displayName };
}

// Mirrors the BFF/OAuth parsers: API Gateway exposes cognito:groups as an
// array, a JSON array string, or a bracketed comma-delimited string.
function claimGroups(value) {
  if (Array.isArray(value)) return value.filter((group) => typeof group === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((group) => typeof group === "string");
  } catch {
    // Fall through to the comma-delimited form.
  }
  return value.replace(/^\[|\]$/g, "").split(",")
    .map((group) => group.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

// Monday app credentials from Secrets Manager; 503 when the integration isn't
// configured yet.
async function loadAppSecret(getAppSecret) {
  const secret = await getAppSecret();
  const clientId = secret?.clientId ?? secret?.client_id;
  const clientSecret = secret?.clientSecret ?? secret?.client_secret;
  if (!clientId || !clientSecret) {
    throw new ApiError(503, "provider_not_configured", "The Monday integration is not configured yet.");
  }
  return { clientId, clientSecret, appId: secret?.appId ?? secret?.app_id };
}

// Only same-site paths are allowed after OAuth (no //host or backslash
// tricks), so the callback can't become an open redirect.
function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }
  return value.slice(0, 500);
}

// Full app URL for a safe return path with the given query parameters.
function buildAppRedirect(appUrl, returnTo, params) {
  const url = new URL(sanitizeReturnTo(returnTo), appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// The agentId from the query string or JSON body, if it's well-formed.
function readAgentId(event) {
  const fromQuery = event?.queryStringParameters?.agentId;
  const fromBody = readBody(event)?.agentId;
  const value = typeof fromQuery === "string" && fromQuery ? fromQuery : fromBody;
  return typeof value === "string" && AGENT_ID_PATTERN.test(value) ? value : null;
}

// Parses the JSON body (base64 or plain); null when missing or invalid.
function readBody(event) {
  if (typeof event?.body !== "string" || !event.body) return null;
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Case-insensitive header lookup.
function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

// JSON response that is never cached.
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

// 302 redirect that is never cached.
function redirect(location) {
  return { statusCode: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}
