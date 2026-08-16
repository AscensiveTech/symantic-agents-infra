import { createGoogleCalendarClient } from "./google.mjs";
import { createMicrosoftCalendarClient } from "./microsoft.mjs";

const TOKEN_ENDPOINTS = {
  "google-calendar": "https://oauth2.googleapis.com/token",
  "microsoft-365-calendar":
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};

const MICROSOFT_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
];

export class CalendarReauthRequiredError extends Error {
  constructor(reason = "calendar_reauth_required") {
    super("Calendar authorization expired");
    this.name = "CalendarReauthRequiredError";
    this.code = "calendar_reauth_required";
    this.reason = reason;
    this.reauthRequired = true;
  }
}

export function createCalendarAdapter({
  connectionStore,
  decryptToken,
  encryptToken,
  getOAuthSecret,
  fetchImpl = globalThis.fetch,
  providerClients = {},
  now = Date.now,
  tokenCacheSkewMs = 60_000,
}) {
  if (!connectionStore?.get) {
    throw new TypeError("Calendar connection store is required");
  }

  const clients = {
    "google-calendar": providerClients["google-calendar"] ??
      createGoogleCalendarClient({ fetchImpl }),
    "microsoft-365-calendar": providerClients["microsoft-365-calendar"] ??
      createMicrosoftCalendarClient({ fetchImpl }),
  };
  const accessTokenCache = new Map();
  const refreshPromises = new Map();
  const invalidGrantFailures = new Map();

  async function invoke(operation, input) {
    const connection = await connectionStore.get(input.workspaceId);
    requireUsableConnection(connection);
    const client = clients[connection.provider];
    if (!client?.[operation]) {
      throw calendarError(
        "Unsupported calendar provider",
        "unsupported_provider",
        400,
      );
    }

    const providerInput = {
      ...input,
      calendarId: connection.selectedCalendarId,
      timezone: input.timezone || connection.calendarTimezone || "UTC",
      providerId: connection.provider === "google-calendar"
        ? input.googleEventId
        : input.microsoftTransactionId,
    };
    let accessToken = await getAccessToken(connection);
    try {
      return await client[operation]({ ...providerInput, accessToken });
    } catch (error) {
      if (error?.statusCode !== 401) throw error;
    }

    accessTokenCache.delete(connection.workspaceId);
    accessToken = await getAccessToken(connection, { forceRefresh: true });
    try {
      return await client[operation]({ ...providerInput, accessToken });
    } catch (error) {
      if (error?.statusCode !== 401) throw error;
      await markReauthRequired(connection.workspaceId, "repeated_401");
      throw new CalendarReauthRequiredError("repeated_401");
    }
  }

  async function getAccessToken(connection, { forceRefresh = false } = {}) {
    if (
      connection.provider === "microsoft-365-calendar" &&
      forceRefresh !== true
    ) {
      const cached = accessTokenCache.get(connection.workspaceId);
      if (
        cached?.provider === connection.provider &&
        cached?.credentialFingerprints.has(
          credentialFingerprint(connection),
        ) &&
        cached.expiresAt - tokenCacheSkewMs > Number(now())
      ) {
        return cached.accessToken;
      }
    }

    const refreshKey = `${connection.provider}\0${connection.workspaceId}`;
    const inFlight = refreshPromises.get(refreshKey);
    if (inFlight) return inFlight;
    const refresh = refreshAccessToken(connection)
      .finally(() => {
        if (refreshPromises.get(refreshKey) === refresh) {
          refreshPromises.delete(refreshKey);
        }
      });
    refreshPromises.set(refreshKey, refresh);
    return refresh;
  }

  async function refreshAccessToken(connection, {
    allowRaceRecovery = true,
  } = {}) {
    if (typeof decryptToken !== "function") {
      throw new Error("Calendar token decryption is not configured");
    }
    const endpoint = TOKEN_ENDPOINTS[connection.provider];
    if (!endpoint) {
      throw calendarError(
        "Unsupported calendar provider",
        "unsupported_provider",
        400,
      );
    }
    const secret = normalizeOAuthSecret(
      await getOAuthSecret(connection.provider),
    );
    const refreshToken = await decryptToken({
      encryptedToken: connection.encryptedRefreshToken,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
    });
    const form = {
      client_id: secret.clientId,
      client_secret: secret.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    };
    if (connection.provider === "microsoft-365-calendar") {
      form.scope = MICROSOFT_SCOPES.join(" ");
    }
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const value = await readJson(response);
    if (!response.ok) {
      if (value?.error === "invalid_grant" || response.status === 401) {
        const reason = value?.error || "invalid_grant";
        accessTokenCache.delete(connection.workspaceId);
        if (connection.provider !== "microsoft-365-calendar") {
          await markReauthRequired(connection.workspaceId, reason);
          throw new CalendarReauthRequiredError(reason);
        }
        if (allowRaceRecovery) {
          const latest = await connectionStore.get(connection.workspaceId);
          if (
            latest &&
            credentialFingerprint(latest) !== credentialFingerprint(connection)
          ) {
            requireUsableConnection(latest);
            invalidGrantFailures.delete(connection.workspaceId);
            return refreshAccessToken(latest, { allowRaceRecovery: false });
          }
        }
        const previous = invalidGrantFailures.get(connection.workspaceId);
        const fingerprint = credentialFingerprint(connection);
        const count = previous?.fingerprint === fingerprint
          ? previous.count + 1
          : 1;
        invalidGrantFailures.set(connection.workspaceId, {
          fingerprint,
          count,
        });
        if (count >= 2) {
          await markReauthRequired(connection.workspaceId, reason);
          throw new CalendarReauthRequiredError(reason);
        }
        throw calendarError(
          "Calendar token refresh failed",
          "provider_token_error",
          502,
        );
      }
      throw calendarError(
        "Calendar token refresh failed",
        "provider_token_error",
        502,
      );
    }
    if (typeof value?.access_token !== "string" || value.access_token.length === 0) {
      throw calendarError(
        "Calendar provider omitted an access token",
        "provider_token_error",
        502,
      );
    }
    invalidGrantFailures.delete(connection.workspaceId);
    const persistedConnection = await persistRotatedToken(
      connection,
      value.refresh_token,
    );
    const expiresInSeconds = Number(value.expires_in);
    if (
      connection.provider === "microsoft-365-calendar" &&
      Number.isFinite(expiresInSeconds) &&
      expiresInSeconds > 0
    ) {
      accessTokenCache.set(connection.workspaceId, {
        provider: connection.provider,
        credentialFingerprints: new Set([
          credentialFingerprint(connection),
          credentialFingerprint(persistedConnection ?? connection),
        ]),
        accessToken: value.access_token,
        expiresAt: Number(now()) + expiresInSeconds * 1_000,
      });
    }
    return value.access_token;
  }

  async function persistRotatedToken(connection, rotatedToken) {
    if (
      typeof rotatedToken !== "string" ||
      rotatedToken.length === 0 ||
      typeof encryptToken !== "function" ||
      typeof connectionStore.rotateToken !== "function"
    ) {
      return connection;
    }
    const encryptedRefreshToken = await encryptToken({
      token: rotatedToken,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
    });
    try {
      return await connectionStore.rotateToken({
        workspaceId: connection.workspaceId,
        provider: connection.provider,
        expectedVersion: connection.tokenVersion,
        encryptedRefreshToken,
      });
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") throw error;
      return null;
    }
  }

  async function markReauthRequired(workspaceId, reason) {
    if (typeof connectionStore.markReauthRequired === "function") {
      await connectionStore.markReauthRequired(workspaceId, reason);
    }
  }

  return {
    getAvailability: (input) => invoke("getAvailability", input),
    createBooking: (input) => invoke("createBooking", input),
    rescheduleBooking: (input) => invoke("rescheduleBooking", input),
    cancelBooking: (input) => invoke("cancelBooking", input),
  };
}

function credentialFingerprint(connection) {
  return [
    connection?.provider,
    connection?.tokenVersion,
    connection?.encryptedRefreshToken,
  ].join("\0");
}

function requireUsableConnection(connection) {
  if (
    !connection ||
    connection.connectionState === "reauth_required" ||
    connection.bookingToolsEnabled === false
  ) {
    throw new CalendarReauthRequiredError("connection_unavailable");
  }
  if (
    connection.connectionState !== "connected" ||
    !connection.selectedCalendarId ||
    !connection.encryptedRefreshToken
  ) {
    throw calendarError(
      "Calendar is not connected",
      "calendar_not_connected",
      409,
    );
  }
}

function normalizeOAuthSecret(secret) {
  const clientId = secret?.clientId ?? secret?.client_id;
  const clientSecret = secret?.clientSecret ?? secret?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth secret must contain clientId and clientSecret");
  }
  return { clientId, clientSecret };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function calendarError(message, code, statusCode) {
  const error = new Error(message);
  error.name = "CalendarAdapterError";
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

let defaultAdapterPromise;

export async function getDefaultCalendarAdapter() {
  defaultAdapterPromise ??= createDefaultCalendarAdapter();
  return defaultAdapterPromise;
}

async function createDefaultCalendarAdapter() {
  const [dynamodb, kms, secrets, { createDynamoToolsStore }] =
    await Promise.all([
      import("@aws-sdk/client-dynamodb"),
      import("@aws-sdk/client-kms"),
      import("@aws-sdk/client-secrets-manager"),
      import("../store.mjs"),
    ]);
  const store = createDynamoToolsStore(
    new dynamodb.DynamoDBClient({}),
    dynamodb,
    {
      calendarConnections: process.env.CALENDAR_CONNECTIONS_TABLE,
      appointments: process.env.APPOINTMENTS_TABLE,
      leads: process.env.LEADS_TABLE,
      messages: process.env.MESSAGES_TABLE,
      calls: process.env.CALLS_TABLE,
      agents: process.env.AGENTS_TABLE,
      businessProfiles: process.env.BUSINESS_PROFILES_TABLE,
    },
  );
  const kmsClient = new kms.KMSClient({});
  const secretsClient = new secrets.SecretsManagerClient({});
  const secretCache = new Map();
  const getOAuthSecret = async (provider) => {
    const secretId = provider === "google-calendar"
      ? process.env.GOOGLE_OAUTH_SECRET_ARN
      : process.env.MICROSOFT_OAUTH_SECRET_ARN;
    if (!secretId) throw new Error("Calendar OAuth secret ARN is required");
    if (!secretCache.has(secretId)) {
      secretCache.set(secretId, secretsClient.send(
        new secrets.GetSecretValueCommand({ SecretId: secretId }),
      ).then((result) => {
        if (!result.SecretString) throw new Error("OAuth secret string is empty");
        return JSON.parse(result.SecretString);
      }));
    }
    return secretCache.get(secretId);
  };
  const tokenCrypto = {
    async decryptToken({ encryptedToken, workspaceId, provider }) {
      const result = await kmsClient.send(new kms.DecryptCommand({
        CiphertextBlob: Buffer.from(encryptedToken, "base64"),
        EncryptionContext: { workspaceId, provider },
      }));
      if (!result.Plaintext) throw new Error("KMS did not return plaintext");
      return new TextDecoder().decode(result.Plaintext);
    },
    async encryptToken({ token, workspaceId, provider }) {
      const keyId = process.env.CALENDAR_TOKENS_KMS_KEY_ID;
      if (!keyId) throw new Error("CALENDAR_TOKENS_KMS_KEY_ID is required");
      const result = await kmsClient.send(new kms.EncryptCommand({
        KeyId: keyId,
        Plaintext: new TextEncoder().encode(token),
        EncryptionContext: { workspaceId, provider },
      }));
      if (!result.CiphertextBlob) throw new Error("KMS did not return ciphertext");
      return Buffer.from(result.CiphertextBlob).toString("base64");
    },
  };
  return createCalendarAdapter({
    connectionStore: {
      get: (workspaceId) => store.getCalendarConnection(workspaceId),
      markReauthRequired: (workspaceId, reason) =>
        store.markCalendarReauthRequired(workspaceId, reason),
      rotateToken: (input) => store.rotateCalendarToken(input),
    },
    decryptToken: tokenCrypto.decryptToken,
    encryptToken: tokenCrypto.encryptToken,
    getOAuthSecret,
  });
}

export async function getAvailability(input) {
  return (await getDefaultCalendarAdapter()).getAvailability(input);
}

export async function createBooking(input) {
  return (await getDefaultCalendarAdapter()).createBooking(input);
}

export async function rescheduleBooking(input) {
  return (await getDefaultCalendarAdapter()).rescheduleBooking(input);
}

export async function cancelBooking(input) {
  return (await getDefaultCalendarAdapter()).cancelBooking(input);
}
