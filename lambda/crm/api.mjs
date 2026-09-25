import { randomBytes } from "node:crypto";

import { CRM_ERROR, CrmError, describeError } from "./errors.mjs";
import { FIELD_TYPES, suggestMapping } from "./monday/adapter.mjs";
import { buildAuthorizeUrl, createPkcePair, verifyMondayJwt } from "./monday/oauth.mjs";
import { isConnectionUsable } from "./provider.mjs";

const PROVIDER = "monday";
const OAUTH_STATE_PROVIDER = "monday-crm";
const STATE_TTL_SECONDS = 600;
const RETRY_WINDOW_DAYS = 7;
const MAX_REQUEUE = 500;
const ADMIN_ROLES = new Set(["company-admin", "super-admin"]);
const DEFAULT_RETURN_TO = "/integrations";

class ApiError extends Error {
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
  const callbackUri = () => `${String(apiBaseUrl).replace(/\/+$/, "")}/crm/oauth/monday/callback`;

  async function requireIdentity(event, { admin = false } = {}) {
    const identity = await resolveIdentity(event, store);
    if (!identity) throw new ApiError(401, "unauthorized", "Unauthorized");
    if (admin && !identity.roles.some((role) => ADMIN_ROLES.has(role))) {
      throw new ApiError(403, "forbidden", "Only a workspace administrator can manage the CRM connection");
    }
    return identity;
  }

  async function requireUsableSession(workspaceId, operation) {
    const connection = await store.getConnection(workspaceId, PROVIDER);
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
  async function requeueFailed(workspaceId) {
    const since = new Date(Number(now()) - RETRY_WINDOW_DAYS * 86_400_000).toISOString();
    const failed = (await store.listFailedCalls(workspaceId, since)).slice(0, MAX_REQUEUE);
    let requeued = 0;
    for (const call of failed) {
      if (await store.markCallQueued(workspaceId, call.callId, PROVIDER)) {
        await enqueue({ workspaceId, callId: call.callId, provider: PROVIDER });
        requeued += 1;
      }
    }
    if (requeued) metrics?.emit("SyncRequeued", requeued, { Provider: PROVIDER });
    return requeued;
  }

  async function revalidate(workspaceId, connection) {
    if (!connection?.mapping) return connection;
    try {
      const outcome = await sessions.withSession(connection, (session) =>
        adapter.validateMapping(session, connection.mapping)
      );
      return await store.saveMapping(workspaceId, PROVIDER, connection.mapping, {
        status: outcome.ok ? "valid" : "invalid",
        problems: outcome.problems,
      }) ?? connection;
    } catch (error) {
      log.warn?.("CRM mapping revalidation failed", { workspaceId, ...describeError(error) });
      return connection;
    }
  }

  const routes = {
    async "GET /crm/connection"(event) {
      const identity = await requireIdentity(event);
      const connection = await store.getConnection(identity.workspaceId, PROVIDER);
      return json(200, toPublicConnection(connection, now));
    },

    async "POST /crm/monday/start"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const body = readBody(event);
      const secret = await loadAppSecret(getAppSecret);
      const { verifier, challenge } = createPkcePair();
      const state = randomState();
      await store.putOAuthState({
        state,
        provider: OAUTH_STATE_PROVIDER,
        workspaceId: identity.workspaceId,
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
      const back = (returnTo, params) => redirect(buildAppRedirect(appUrl, returnTo, params));
      const stateRecord = typeof query.state === "string" && query.state
        ? await store.consumeOAuthState(query.state)
        : null;
      if (
        !stateRecord ||
        stateRecord.provider !== OAUTH_STATE_PROVIDER ||
        stateRecord.redirectUri !== callbackUri() ||
        Number(stateRecord.expiresAt) * 1000 < Number(now())
      ) {
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "invalid_state" });
        return back(DEFAULT_RETURN_TO, { crm: "error", reason: "invalid_state" });
      }
      if (query.error || typeof query.code !== "string" || !query.code) {
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "denied" });
        return back(stateRecord.returnTo, { crm: "error", reason: "authorization_denied" });
      }
      const { workspaceId } = stateRecord;
      try {
        const tokens = await oauthClient.exchangeCode({
          code: query.code,
          redirectUri: stateRecord.redirectUri,
          codeVerifier: stateRecord.codeVerifier,
        });
        const account = await adapter.describeAccount({ accessToken: tokens.accessToken, mapping: null });
        const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
          tokenCrypto.encrypt({ plaintext: tokens.accessToken, workspaceId, provider: PROVIDER, purpose: "access" }),
          tokenCrypto.encrypt({ plaintext: tokens.refreshToken, workspaceId, provider: PROVIDER, purpose: "refresh" }),
        ]);
        let connection = await store.saveAuthorization(workspaceId, PROVIDER, {
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
        connection = await revalidate(workspaceId, connection);
        if (isConnectionUsable(connection)) await requeueFailed(workspaceId);
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "connected" });
        log.info?.("CRM connected", { workspaceId, provider: PROVIDER, accountId: account.accountId });
        return back(stateRecord.returnTo, { crm: "connected" });
      } catch (error) {
        metrics?.count("OAuth", { Provider: PROVIDER, Outcome: "failed" });
        log.error?.("CRM OAuth callback failed", { workspaceId, ...describeError(error) });
        return back(stateRecord.returnTo, { crm: "error", reason: "connection_failed" });
      }
    },

    async "DELETE /crm/connection"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const connection = await store.getConnection(identity.workspaceId, PROVIDER);
      if (!connection) return json(200, null);
      // Best effort: revoke at Monday so the grant dies there too. Our copy is
      // deleted either way.
      if (connection.encryptedRefreshToken) {
        try {
          const refreshToken = await tokenCrypto.decrypt({
            ciphertext: connection.encryptedRefreshToken,
            workspaceId: identity.workspaceId,
            provider: PROVIDER,
            purpose: "refresh",
          });
          await oauthClient.revoke({ token: refreshToken, hint: "refresh_token" });
        } catch (error) {
          log.warn?.("Monday token revoke failed; deleting local tokens anyway", describeError(error));
        }
      }
      const saved = await store.disconnect(identity.workspaceId, PROVIDER, "user_disconnected");
      log.info?.("CRM disconnected", { workspaceId: identity.workspaceId, provider: PROVIDER, by: identity.userId });
      return json(200, toPublicConnection(saved, now));
    },

    async "GET /crm/monday/boards"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const { boards, users } = await requireUsableSession(identity.workspaceId, async (session) => ({
        boards: await adapter.listBoards(session),
        users: await adapter.listUsers(session),
      }));
      return json(200, {
        boards: boards.map((board) => ({
          ...board,
          hasPhoneColumn: board.columns.some((column) => column.type === "phone"),
          suggestion: suggestMapping(board),
        })),
        users,
        fieldTypes: FIELD_TYPES,
      });
    },

    async "PUT /crm/mapping"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const requested = normalizeMappingInput(readBody(event)?.mapping);
      const outcome = await requireUsableSession(identity.workspaceId, (session) =>
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
      const saved = await store.saveMapping(identity.workspaceId, PROVIDER, mapping, { status: "valid", problems: [] });
      const requeued = await requeueFailed(identity.workspaceId);
      log.info?.("CRM mapping saved", { workspaceId: identity.workspaceId, provider: PROVIDER, requeued });
      return json(200, { ...toPublicConnection(saved, now), requeued });
    },

    async "POST /crm/sync/retry"(event) {
      const identity = await requireIdentity(event, { admin: true });
      const connection = await store.getConnection(identity.workspaceId, PROVIDER);
      if (!isConnectionUsable(connection)) {
        throw new ApiError(409, "not_ready", "Finish connecting Monday before retrying.");
      }
      return json(200, { requeued: await requeueFailed(identity.workspaceId) });
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
          if (connection.connectionState !== "disconnected") {
            await store.disconnect(connection.workspaceId, PROVIDER, "app_uninstalled");
          }
        }
        log.info?.("Monday app uninstalled", { accountId, disconnected: connections.length });
      }
      return json(200, { ok: true });
    },
  };

  return async function handleApi(event) {
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
  };
}

function toPublicConnection(connection, now = Date.now) {
  if (!connection) return null;
  const refreshExpiry = Number(connection.refreshTokenExpiresAt);
  const paused = Number(connection.pausedUntil) > Number(now());
  return {
    provider: connection.provider,
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

async function loadAppSecret(getAppSecret) {
  const secret = await getAppSecret();
  const clientId = secret?.clientId ?? secret?.client_id;
  const clientSecret = secret?.clientSecret ?? secret?.client_secret;
  if (!clientId || !clientSecret) {
    throw new ApiError(503, "provider_not_configured", "The Monday integration is not configured yet.");
  }
  return { clientId, clientSecret, appId: secret?.appId ?? secret?.app_id };
}

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }
  return value.slice(0, 500);
}

function buildAppRedirect(appUrl, returnTo, params) {
  const url = new URL(sanitizeReturnTo(returnTo), appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

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

function readHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return { statusCode: 302, headers: { location, "cache-control": "no-store" }, body: "" };
}
