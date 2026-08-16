import { randomBytes } from "node:crypto";

export const PROVIDERS = Object.freeze({
  "google-calendar": {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ],
  },
  "microsoft-365-calendar": {
    authorizationEndpoint:
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenEndpoint:
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Calendars.ReadWrite"],
  },
});

const DEFAULT_RETURN_TO = "/agents/new/connections";
const DEFAULT_STATE_TTL_SECONDS = 600;

class OAuthRequestError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request") {
    super(message);
    this.name = "OAuthRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function buildAuthorizationUrl({
  provider,
  clientId,
  redirectUri,
  state,
}) {
  const config = getProviderConfig(provider);
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  if (provider === "google-calendar") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("response_mode", "query");
  }
  return url.toString();
}

export function createInMemoryStateStore(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.state, { ...record }]));
  return {
    async put(record) {
      if (records.has(record.state)) throw new Error("OAuth state already exists");
      records.set(record.state, { ...record });
      return { ...record };
    },
    async consume(state) {
      const record = records.get(state);
      records.delete(state);
      return record ? { ...record } : null;
    },
    async peek(state) {
      const record = records.get(state);
      return record ? { ...record } : null;
    },
  };
}

export async function consumeOAuthState({
  state,
  provider,
  redirectUri,
  stateStore,
  now = Date.now,
}) {
  if (typeof state !== "string" || state.length < 8) {
    throw new OAuthRequestError("Invalid OAuth state", 400, "invalid_state");
  }
  const record = await stateStore.consume(state);
  if (!record) {
    throw new OAuthRequestError(
      "OAuth state is invalid or already used",
      400,
      "invalid_state",
    );
  }
  if (record.expiresAt <= Math.floor(now() / 1000)) {
    throw new OAuthRequestError("OAuth state expired", 400, "expired_state");
  }
  if (record.provider !== provider) {
    throw new OAuthRequestError(
      "OAuth state provider mismatch",
      400,
      "invalid_state",
    );
  }
  if (record.redirectUri !== redirectUri) {
    throw new OAuthRequestError(
      "OAuth state redirect mismatch",
      400,
      "invalid_state",
    );
  }
  if (
    typeof record.workspaceId !== "string" ||
    record.workspaceId.length === 0 ||
    typeof record.userId !== "string" ||
    record.userId.length === 0
  ) {
    throw new OAuthRequestError(
      "OAuth state identity binding is invalid",
      400,
      "invalid_state",
    );
  }
  return record;
}

export async function encryptRefreshToken(
  { token, workspaceId, provider },
  { client, EncryptCommand, keyId },
) {
  if (!token) throw new TypeError("Refresh token is required");
  const result = await client.send(new EncryptCommand({
    KeyId: keyId,
    Plaintext: new TextEncoder().encode(token),
    EncryptionContext: { workspaceId, provider },
  }));
  if (!result.CiphertextBlob) throw new Error("KMS did not return ciphertext");
  return Buffer.from(result.CiphertextBlob).toString("base64");
}

export async function decryptRefreshToken(
  { encryptedToken, workspaceId, provider },
  { client, DecryptCommand },
) {
  if (!encryptedToken) throw new TypeError("Encrypted refresh token is required");
  const result = await client.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(encryptedToken, "base64"),
    EncryptionContext: { workspaceId, provider },
  }));
  if (!result.Plaintext) throw new Error("KMS did not return plaintext");
  return new TextDecoder().decode(result.Plaintext);
}

export function createInMemoryConnectionStore(initialRecords = []) {
  const records = new Map(
    initialRecords.map((record) => [record.workspaceId, cloneRecord(record)]),
  );
  return {
    async get(workspaceId) {
      const record = records.get(workspaceId);
      return record ? cloneRecord(record) : null;
    },
    async save(record) {
      records.set(record.workspaceId, cloneRecord(record));
      return cloneRecord(record);
    },
    async select(workspaceId, provider, calendarId, calendarTimezone) {
      const current = records.get(workspaceId);
      if (
        !current ||
        current.provider !== provider ||
        current.connectionState !== "connected"
      ) {
        throw new OAuthRequestError(
          "Provider is not connected",
          409,
          "provider_not_connected",
        );
      }
      const next = {
        ...current,
        selectedCalendarId: calendarId,
        calendarTimezone,
        connectionState: "connected",
      };
      records.set(workspaceId, next);
      return cloneRecord(next);
    },
    async disconnect(workspaceId) {
      const current = records.get(workspaceId);
      if (!current) return null;
      const next = {
        ...current,
        selectedCalendarId: null,
        connectionState: "disconnected",
      };
      delete next.encryptedRefreshToken;
      records.set(workspaceId, next);
      return cloneRecord(next);
    },
    async compareAndSwapToken(
      workspaceId,
      provider,
      expectedVersion,
      encryptedRefreshToken,
    ) {
      const current = records.get(workspaceId);
      if (
        !current ||
        current.provider !== provider ||
        current.tokenVersion !== expectedVersion
      ) {
        throw new Error("Refresh token version mismatch");
      }
      const next = {
        ...current,
        encryptedRefreshToken,
        tokenVersion: expectedVersion + 1,
      };
      records.set(workspaceId, next);
      return cloneRecord(next);
    },
  };
}

let microsoftRotationDependencies;

export function configureMicrosoftRotationForTests(dependencies) {
  microsoftRotationDependencies = dependencies;
}

export async function rotateMicrosoftToken({
  workspaceId,
  expectedVersion,
  newToken,
}, dependencies = microsoftRotationDependencies) {
  if (!dependencies?.store || !dependencies?.encryptToken) {
    throw new Error("Microsoft token rotation dependencies are not configured");
  }
  const encryptedRefreshToken = await dependencies.encryptToken({
    token: newToken,
    workspaceId,
    provider: "microsoft-365-calendar",
  });
  try {
    return await dependencies.store.compareAndSwapToken(
      workspaceId,
      "microsoft-365-calendar",
      expectedVersion,
      encryptedRefreshToken,
    );
  } catch (error) {
    if (
      error?.name === "ConditionalCheckFailedException" ||
      /version|conditional/i.test(error?.message ?? "")
    ) {
      throw new Error("Microsoft refresh token version mismatch");
    }
    throw error;
  }
}

export function createProviderClient(provider, { fetchImpl = globalThis.fetch } = {}) {
  const config = getProviderConfig(provider);
  return {
    async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
      const body = {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      };
      const tokens = await postForm(fetchImpl, config.tokenEndpoint, body);
      return normalizeTokenResponse(tokens, provider);
    },
    async refreshToken({ refreshToken, clientId, clientSecret }) {
      const body = {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      };
      if (provider === "microsoft-365-calendar") {
        body.scope = config.scopes.join(" ");
      }
      const tokens = await postForm(fetchImpl, config.tokenEndpoint, body);
      return normalizeTokenResponse(tokens, provider);
    },
    async listCalendars({ accessToken }) {
      if (provider === "google-calendar") {
        return listGoogleCalendars(fetchImpl, accessToken);
      }
      return listMicrosoftCalendars(fetchImpl, accessToken);
    },
  };
}

export function createHandler(options = {}) {
  const {
    getStateStore = getDefaultStateStore,
    getConnectionStore = getDefaultConnectionStore,
    getOAuthSecret = getDefaultOAuthSecret,
    getTokenCrypto = getDefaultTokenCrypto,
    getProviderClient = (provider) => createProviderClient(provider),
    redirectBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL,
    appUrl = process.env.APP_URL,
    stateTtlSeconds = Number(process.env.OAUTH_STATE_TTL_SECONDS) ||
      DEFAULT_STATE_TTL_SECONDS,
    now = Date.now,
    randomState = () => randomBytes(32).toString("base64url"),
  } = options;

  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
    const startMatch = path.match(/^\/oauth\/([^/]+)\/start$/);
    const callbackMatch = path.match(/^\/oauth\/([^/]+)\/callback$/);

    try {
      if (method === "GET" && startMatch) {
        const provider = requireProvider(startMatch[1]);
        const identity = readIdentity(event);
        if (!identity) return json(401, { message: "Unauthorized" });
        const baseUrl = requireAbsoluteUrl(redirectBaseUrl, "OAuth redirect base URL");
        const callbackUri = `${baseUrl}/oauth/${provider}/callback`;
        const secret = normalizeSecret(await getOAuthSecret(provider));
        const state = randomState();
        const returnTo = sanitizeReturnTo(
          event?.queryStringParameters?.returnTo,
        );
        const stateStore = await getStateStore();
        await stateStore.put({
          state,
          workspaceId: identity.workspaceId,
          userId: identity.userId,
          provider,
          redirectUri: callbackUri,
          returnTo,
          expiresAt: Math.floor(now() / 1000) + stateTtlSeconds,
        });
        return json(200, {
          authorizeUrl: buildAuthorizationUrl({
            provider,
            clientId: secret.clientId,
            redirectUri: callbackUri,
            state,
          }),
        });
      }

      if (method === "GET" && callbackMatch) {
        const provider = requireProvider(callbackMatch[1]);
        const baseUrl = requireAbsoluteUrl(redirectBaseUrl, "OAuth redirect base URL");
        const callbackUri = `${baseUrl}/oauth/${provider}/callback`;
        const stateStore = await getStateStore();
        const stateRecord = await consumeOAuthState({
          state: event?.queryStringParameters?.state,
          provider,
          redirectUri: callbackUri,
          stateStore,
          now,
        });
        try {
          if (event?.queryStringParameters?.error) {
            return redirect(buildAppRedirect(appUrl, stateRecord.returnTo, {
              calendar: "error",
              reason: "authorization_denied",
            }));
          }
          const code = event?.queryStringParameters?.code;
          if (typeof code !== "string" || code.length === 0) {
            throw new OAuthRequestError(
              "Authorization code is required",
              400,
              "missing_code",
            );
          }

          const secret = normalizeSecret(await getOAuthSecret(provider));
          const providerClient = getProviderClient(provider);
          const tokens = await providerClient.exchangeCode({
            code,
            clientId: secret.clientId,
            clientSecret: secret.clientSecret,
            redirectUri: callbackUri,
          });
          const calendars = await providerClient.listCalendars({
            accessToken: tokens.accessToken,
          });
          const selected = selectDefaultCalendar(calendars);
          const connectionStore = await getConnectionStore();
          const existing = await connectionStore.get(stateRecord.workspaceId);
          const tokenCrypto = await getTokenCrypto();

          let encryptedRefreshToken;
          let tokenVersion;
          if (tokens.refreshToken) {
            encryptedRefreshToken = await tokenCrypto.encryptToken({
              token: tokens.refreshToken,
              workspaceId: stateRecord.workspaceId,
              provider,
            });
            tokenVersion = existing?.provider === provider
              ? existing.tokenVersion + 1
              : 1;
          } else if (
            provider === "google-calendar" &&
            existing?.provider === provider &&
            existing.encryptedRefreshToken
          ) {
            encryptedRefreshToken = existing.encryptedRefreshToken;
            tokenVersion = existing.tokenVersion;
          } else {
            throw new OAuthRequestError(
              "Provider did not return a refresh token",
              502,
              "missing_refresh_token",
            );
          }

          const connection = {
            workspaceId: stateRecord.workspaceId,
            provider,
            selectedCalendarId: selected.id,
            calendarTimezone: selected.timezone || "UTC",
            encryptedRefreshToken,
            tokenVersion,
            scopes: tokens.scopes.length > 0
              ? tokens.scopes
              : [...PROVIDERS[provider].scopes],
            connectionState: "connected",
            ...(provider === "microsoft-365-calendar" && tokens.tid
              ? { tid: tokens.tid }
              : {}),
          };
          await connectionStore.save(connection);
          return redirect(buildAppRedirect(appUrl, stateRecord.returnTo, {
            calendar: "connected",
            provider,
          }));
        } catch (error) {
          console.error("Calendar OAuth callback failed after state consume", {
            name: error?.name,
            message: error?.message,
            code: error?.code,
          });
          return redirect(buildAppRedirect(appUrl, stateRecord.returnTo, {
            calendar: "error",
            reason: error instanceof OAuthRequestError ? error.code : "oauth_failed",
          }));
        }
      }

      if (path === "/calendars/connection" && method === "GET") {
        const identity = readIdentity(event);
        if (!identity) return json(401, { message: "Unauthorized" });
        const store = await getConnectionStore();
        return json(200, toPublicConnection(await store.get(identity.workspaceId)));
      }

      if (path === "/calendars/connection" && method === "DELETE") {
        const identity = readIdentity(event);
        if (!identity) return json(401, { message: "Unauthorized" });
        const store = await getConnectionStore();
        return json(200, toPublicConnection(await store.disconnect(identity.workspaceId)));
      }

      if (path === "/calendars/select" && method === "POST") {
        const identity = readIdentity(event);
        if (!identity) return json(401, { message: "Unauthorized" });
        const body = readBody(event);
        const provider = requireProvider(body?.provider);
        if (typeof body?.calendarId !== "string" || body.calendarId.length === 0) {
          throw new OAuthRequestError("calendarId is required");
        }

        const store = await getConnectionStore();
        const current = await store.get(identity.workspaceId);
        if (
          !current ||
          current.provider !== provider ||
          current.connectionState !== "connected" ||
          !current.encryptedRefreshToken
        ) {
          throw new OAuthRequestError(
            "Provider is not connected",
            409,
            "provider_not_connected",
          );
        }
        const secret = normalizeSecret(await getOAuthSecret(provider));
        const tokenCrypto = await getTokenCrypto();
        const refreshToken = await tokenCrypto.decryptToken({
          encryptedToken: current.encryptedRefreshToken,
          workspaceId: identity.workspaceId,
          provider,
        });
        const providerClient = getProviderClient(provider);
        const tokens = await providerClient.refreshToken({
          refreshToken,
          clientId: secret.clientId,
          clientSecret: secret.clientSecret,
        });
        if (tokens.refreshToken) {
          if (provider === "microsoft-365-calendar") {
            await rotateMicrosoftToken({
              workspaceId: identity.workspaceId,
              expectedVersion: current.tokenVersion,
              newToken: tokens.refreshToken,
            }, {
              store,
              encryptToken: tokenCrypto.encryptToken,
            });
          } else {
            const encrypted = await tokenCrypto.encryptToken({
              token: tokens.refreshToken,
              workspaceId: identity.workspaceId,
              provider,
            });
            await store.compareAndSwapToken(
              identity.workspaceId,
              provider,
              current.tokenVersion,
              encrypted,
            );
          }
        }
        const calendars = await providerClient.listCalendars({
          accessToken: tokens.accessToken,
        });
        const selected = calendars.find(({ id }) => id === body.calendarId);
        if (!selected) {
          throw new OAuthRequestError(
            "Calendar is not available from this provider",
            400,
            "invalid_calendar",
          );
        }
        const connection = await store.select(
          identity.workspaceId,
          provider,
          selected.id,
          selected.timezone || body.calendarTimezone || "UTC",
        );
        return json(200, toPublicConnection(connection));
      }

      return json(404, { message: "Not found" });
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        return json(error.statusCode, {
          message: error.message,
          code: error.code,
        });
      }
      if (error?.name === "ConditionalCheckFailedException") {
        return json(409, {
          message: "Concurrent calendar connection update",
          code: "connection_conflict",
        });
      }
      console.error("Calendar OAuth request failed", {
        name: error?.name,
        message: error?.message,
      });
      return json(500, { message: "Internal server error" });
    }
  };
}

function getProviderConfig(provider) {
  const config = PROVIDERS[provider];
  if (!config) throw new OAuthRequestError("Unsupported calendar provider");
  return config;
}

function requireProvider(provider) {
  getProviderConfig(provider);
  return provider;
}

function readIdentity(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const workspaceId = claims?.sub;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  const userId = claims?.username ??
    claims?.["cognito:username"] ??
    claims?.email ??
    workspaceId;
  if (typeof userId !== "string" || userId.length === 0) return null;
  return { workspaceId, userId };
}

function readBody(event) {
  if (!event?.body) return null;
  try {
    const value = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return JSON.parse(value);
  } catch {
    throw new OAuthRequestError("Invalid JSON body");
  }
}

function sanitizeReturnTo(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(candidate, "https://local.invalid");
    const allowedPath = parsed.pathname === DEFAULT_RETURN_TO ||
      parsed.pathname === "/integrations";
    if (
      parsed.origin !== "https://local.invalid" ||
      !allowedPath
    ) {
      return DEFAULT_RETURN_TO;
    }
    const result = new URL(parsed.pathname, "https://local.invalid");
    if (parsed.pathname === DEFAULT_RETURN_TO) {
      const agentId = parsed.searchParams.get("agentId");
      if (agentId) result.searchParams.set("agentId", agentId);
    }
    return result.pathname + result.search;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function requireAbsoluteUrl(value, label) {
  try {
    const url = new URL(value);
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${label} is required`);
  }
}

function normalizeSecret(secret) {
  const clientId = secret?.clientId ?? secret?.client_id;
  const clientSecret = secret?.clientSecret ?? secret?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth secret must contain clientId and clientSecret");
  }
  return { clientId, clientSecret };
}

function normalizeTokenResponse(tokens, provider) {
  if (typeof tokens?.access_token !== "string" || tokens.access_token.length === 0) {
    throw new OAuthRequestError(
      "Provider did not return an access token",
      502,
      "provider_token_error",
    );
  }
  const scopes = typeof tokens.scope === "string"
    ? tokens.scope.split(/\s+/).filter(Boolean)
    : [...PROVIDERS[provider].scopes];
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string"
      ? tokens.refresh_token
      : null,
    scopes,
    tid: provider === "microsoft-365-calendar"
      ? readJwtClaim(tokens.id_token, "tid")
      : undefined,
  };
}

function readJwtClaim(token, claim) {
  if (typeof token !== "string") return undefined;
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.[claim];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function postForm(fetchImpl, url, values) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new OAuthRequestError(
      "OAuth provider token request failed",
      502,
      "provider_token_error",
    );
  }
  return body;
}

async function getProviderJson(fetchImpl, url, accessToken) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new OAuthRequestError(
      "Calendar provider request failed",
      502,
      "provider_api_error",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new OAuthRequestError(
      "Calendar provider returned invalid JSON",
      502,
      "provider_api_error",
    );
  }
}

async function listGoogleCalendars(fetchImpl, accessToken) {
  const body = await getProviderJson(
    fetchImpl,
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    accessToken,
  );
  return (body?.items ?? [])
    .filter((calendar) => typeof calendar?.id === "string")
    .map((calendar) => ({
      id: calendar.id,
      name: calendar.summary ?? calendar.id,
      timezone: calendar.timeZone ?? "UTC",
      primary: calendar.primary === true,
    }));
}

async function listMicrosoftCalendars(fetchImpl, accessToken) {
  const calendarBody = await getProviderJson(
    fetchImpl,
    "https://graph.microsoft.com/v1.0/me/calendars" +
      "?$select=id,name,isDefaultCalendar,canEdit",
    accessToken,
  );
  return (calendarBody?.value ?? [])
    .filter((calendar) => typeof calendar?.id === "string")
    .map((calendar) => ({
      id: calendar.id,
      name: calendar.name ?? calendar.id,
      timezone: "UTC",
      primary: calendar.isDefaultCalendar === true,
    }));
}

function selectDefaultCalendar(calendars) {
  const selected = calendars.find(({ primary }) => primary) ?? calendars[0];
  if (!selected) {
    throw new OAuthRequestError(
      "Provider returned no calendars",
      422,
      "no_calendars",
    );
  }
  return selected;
}

function buildAppRedirect(appUrl, returnTo, parameters) {
  const base = requireAbsoluteUrl(appUrl, "App URL");
  const url = new URL(sanitizeReturnTo(returnTo), `${base}/`);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function toPublicConnection(connection) {
  if (!connection) return null;
  const { encryptedRefreshToken: _encryptedRefreshToken, workspaceId: _workspaceId, ...value } =
    connection;
  return value;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function redirect(location) {
  return {
    statusCode: 302,
    headers: {
      location,
      "cache-control": "no-store",
    },
    body: "",
  };
}

function cloneRecord(record) {
  return {
    ...record,
    scopes: Array.isArray(record.scopes) ? [...record.scopes] : record.scopes,
  };
}

function toAttributeValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  if (typeof value === "object") {
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [key, toAttributeValue(item)]),
      ),
    };
  }
  throw new TypeError(`Unsupported DynamoDB value: ${typeof value}`);
}

function marshall(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toAttributeValue(item)]),
  );
}

function fromAttributeValue(value) {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL) return null;
  if (value.L) return value.L.map(fromAttributeValue);
  if (value.M) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, item]) => [key, fromAttributeValue(item)]),
    );
  }
  return undefined;
}

function unmarshall(item) {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, fromAttributeValue(value)]),
  );
}

export function createDynamoStateStore(client, commands, tableName) {
  return {
    async put(record) {
      await client.send(new commands.PutItemCommand({
        TableName: tableName,
        Item: marshall(record),
        ConditionExpression: "attribute_not_exists(#state)",
        ExpressionAttributeNames: { "#state": "state" },
      }));
      return record;
    },
    async consume(state) {
      const result = await client.send(new commands.DeleteItemCommand({
        TableName: tableName,
        Key: marshall({ state }),
        ReturnValues: "ALL_OLD",
      }));
      return result.Attributes ? unmarshall(result.Attributes) : null;
    },
  };
}

export function createDynamoConnectionStore(client, commands, tableName) {
  return {
    async get(workspaceId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableName,
        Key: marshall({ workspaceId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },
    async save(record) {
      await client.send(new commands.PutItemCommand({
        TableName: tableName,
        Item: marshall(record),
      }));
      return record;
    },
    async select(workspaceId, provider, calendarId, calendarTimezone) {
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ workspaceId }),
        UpdateExpression:
          "SET selectedCalendarId = :calendarId, " +
          "calendarTimezone = :timezone, connectionState = :connected",
        ConditionExpression: "provider = :provider AND connectionState = :connected",
        ExpressionAttributeValues: marshall({
          ":calendarId": calendarId,
          ":timezone": calendarTimezone,
          ":connected": "connected",
          ":provider": provider,
        }),
        ReturnValues: "ALL_NEW",
      }));
      return unmarshall(result.Attributes);
    },
    async disconnect(workspaceId) {
      try {
        const result = await client.send(new commands.UpdateItemCommand({
          TableName: tableName,
          Key: marshall({ workspaceId }),
          UpdateExpression:
            "SET selectedCalendarId = :none, connectionState = :disconnected " +
            "REMOVE encryptedRefreshToken",
          ConditionExpression: "attribute_exists(workspaceId)",
          ExpressionAttributeValues: marshall({
            ":none": null,
            ":disconnected": "disconnected",
          }),
          ReturnValues: "ALL_NEW",
        }));
        return unmarshall(result.Attributes);
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") return null;
        throw error;
      }
    },
    async compareAndSwapToken(
      workspaceId,
      provider,
      expectedVersion,
      encryptedRefreshToken,
    ) {
      const result = await client.send(new commands.UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ workspaceId }),
        UpdateExpression:
          "SET encryptedRefreshToken = :token, tokenVersion = :nextVersion",
        ConditionExpression:
          "provider = :provider AND tokenVersion = :expectedVersion",
        ExpressionAttributeValues: marshall({
          ":token": encryptedRefreshToken,
          ":nextVersion": expectedVersion + 1,
          ":provider": provider,
          ":expectedVersion": expectedVersion,
        }),
        ReturnValues: "ALL_NEW",
      }));
      return unmarshall(result.Attributes);
    },
  };
}

let awsRuntimePromise;
let stateStorePromise;
let connectionStorePromise;
let tokenCryptoPromise;
const secretPromises = new Map();

async function getAwsRuntime() {
  awsRuntimePromise ??= Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/client-kms"),
    import("@aws-sdk/client-secrets-manager"),
  ]).then(([dynamodb, kms, secrets]) => ({
    dynamodb,
    kms,
    secrets,
    dynamoClient: new dynamodb.DynamoDBClient({}),
    kmsClient: new kms.KMSClient({}),
    secretsClient: new secrets.SecretsManagerClient({}),
  }));
  return awsRuntimePromise;
}

async function getDefaultStateStore() {
  stateStorePromise ??= getAwsRuntime().then(({ dynamodb, dynamoClient }) => {
    if (!process.env.OAUTH_STATES_TABLE) {
      throw new Error("OAUTH_STATES_TABLE is required");
    }
    return createDynamoStateStore(
      dynamoClient,
      dynamodb,
      process.env.OAUTH_STATES_TABLE,
    );
  });
  return stateStorePromise;
}

async function getDefaultConnectionStore() {
  connectionStorePromise ??= getAwsRuntime().then(({ dynamodb, dynamoClient }) => {
    if (!process.env.CALENDAR_CONNECTIONS_TABLE) {
      throw new Error("CALENDAR_CONNECTIONS_TABLE is required");
    }
    return createDynamoConnectionStore(
      dynamoClient,
      dynamodb,
      process.env.CALENDAR_CONNECTIONS_TABLE,
    );
  });
  return connectionStorePromise;
}

async function getDefaultTokenCrypto() {
  tokenCryptoPromise ??= getAwsRuntime().then(({ kms, kmsClient }) => {
    if (!process.env.CALENDAR_TOKENS_KMS_KEY_ID) {
      throw new Error("CALENDAR_TOKENS_KMS_KEY_ID is required");
    }
    const dependencies = {
      client: kmsClient,
      EncryptCommand: kms.EncryptCommand,
      DecryptCommand: kms.DecryptCommand,
      keyId: process.env.CALENDAR_TOKENS_KMS_KEY_ID,
    };
    return {
      encryptToken: (input) => encryptRefreshToken(input, dependencies),
      decryptToken: (input) => decryptRefreshToken(input, dependencies),
    };
  });
  return tokenCryptoPromise;
}

async function getDefaultOAuthSecret(provider) {
  const environmentName = provider === "google-calendar"
    ? "GOOGLE_OAUTH_SECRET_ARN"
    : "MICROSOFT_OAUTH_SECRET_ARN";
  const secretId = process.env[environmentName];
  if (!secretId) throw new Error(`${environmentName} is required`);
  if (!secretPromises.has(secretId)) {
    secretPromises.set(secretId, getAwsRuntime().then(async ({ secrets, secretsClient }) => {
      const result = await secretsClient.send(new secrets.GetSecretValueCommand({
        SecretId: secretId,
      }));
      if (!result.SecretString) throw new Error("OAuth secret string is empty");
      return JSON.parse(result.SecretString);
    }));
  }
  return secretPromises.get(secretId);
}

export const handler = createHandler();
