import { randomBytes } from "node:crypto";

export const PROVIDER_LABELS = Object.freeze({
  "google-calendar": "Google Calendar",
  "microsoft-365-calendar": "Microsoft 365 Calendar",
});

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
const DEFAULT_INVITE_TTL_DAYS = 7;
const INVITE_PATH_PREFIX = "/connect-calendar";
// Invite ids are the only credential on the public connect page, so they must
// be unguessable; this matches the entropy of the OAuth state token.
const INVITE_ID_PATTERN = /^[A-Za-z0-9_-]{22,}$/;
const ADMIN_ROLES = new Set(["company-admin", "super-admin"]);

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
      const timestamp = new Date().toISOString();
      const next = {
        ...current,
        selectedCalendarId: calendarId,
        calendarTimezone,
        connectionState: "connected",
        lastSyncedAt: timestamp,
        updatedAt: timestamp,
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

// A calendar invite lets someone who is not a workspace admin - and who may not
// have an account at all - authorize their own calendar. The admin never sees
// the invitee's credentials, only that the connection completed.
export function createInMemoryInviteStore(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.inviteId, { ...record }]));
  return {
    async put(record) {
      records.set(record.inviteId, { ...record });
      return { ...record };
    },
    async get(inviteId) {
      const record = records.get(inviteId);
      return record ? { ...record } : null;
    },
    async listByWorkspace(workspaceId) {
      return [...records.values()]
        .filter((record) => record.workspaceId === workspaceId)
        .map((record) => ({ ...record }));
    },
    async setStatus(inviteId, workspaceId, status, extra = {}) {
      const record = records.get(inviteId);
      if (!record || record.workspaceId !== workspaceId) return null;
      const next = { ...record, status, ...extra };
      records.set(inviteId, next);
      return { ...next };
    },
    async remove(inviteId, workspaceId) {
      const record = records.get(inviteId);
      if (!record || record.workspaceId !== workspaceId) return false;
      records.delete(inviteId);
      return true;
    },
  };
}

export function createDynamoInviteStore(client, commands, tableName) {
  return {
    async put(record) {
      await client.send(new commands.PutItemCommand({
        TableName: tableName,
        Item: marshall(record),
      }));
      return record;
    },
    async get(inviteId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableName,
        Key: marshall({ inviteId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },
    async listByWorkspace(workspaceId) {
      const invites = [];
      let exclusiveStartKey;
      do {
        const result = await client.send(new commands.QueryCommand({
          TableName: tableName,
          IndexName: "workspaceId-index",
          KeyConditionExpression: "workspaceId = :workspaceId",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }));
        invites.push(...(result.Items ?? []).map((item) => unmarshall(item)));
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return invites;
    },
    // The workspace condition is what stops one workspace's admin from
    // revoking or completing another workspace's invite by id alone.
    async setStatus(inviteId, workspaceId, status, extra = {}) {
      const values = { ":status": status, ":workspaceId": workspaceId };
      const sets = ["#status = :status"];
      for (const [key, value] of Object.entries(extra)) {
        values[`:${key}`] = value;
        sets.push(`${key} = :${key}`);
      }
      try {
        const result = await client.send(new commands.UpdateItemCommand({
          TableName: tableName,
          Key: marshall({ inviteId }),
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "workspaceId = :workspaceId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: marshall(values),
          ReturnValues: "ALL_NEW",
        }));
        return unmarshall(result.Attributes);
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") return null;
        throw error;
      }
    },
    async remove(inviteId, workspaceId) {
      try {
        await client.send(new commands.DeleteItemCommand({
          TableName: tableName,
          Key: marshall({ inviteId }),
          ConditionExpression: "workspaceId = :workspaceId",
          ExpressionAttributeValues: marshall({ ":workspaceId": workspaceId }),
        }));
        return true;
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
  };
}

export function createInMemoryMembershipStore(memberships = []) {
  const byUser = new Map(
    memberships.map((membership) => [membership.userId, { ...membership }]),
  );
  return {
    async getMembership(userId) {
      const membership = byUser.get(userId);
      return membership ? { ...membership } : null;
    },
  };
}

export function createDynamoMembershipStore(client, commands, tableName) {
  return {
    async getMembership(userId) {
      const result = await client.send(new commands.GetItemCommand({
        TableName: tableName,
        Key: marshall({ userId }),
        ConsistentRead: true,
      }));
      return result.Item ? unmarshall(result.Item) : null;
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
    // Which provider account these tokens belong to, so an admin can confirm
    // whose calendar is attached without ever seeing their credentials.
    // Google's primary calendar id is the account's email address, so reading
    // it here avoids requesting a userinfo scope we would otherwise not need.
    async getAccountEmail({ accessToken, calendars }) {
      if (provider === "google-calendar") {
        return calendars?.find(({ primary }) => primary)?.id ?? null;
      }
      const me = await getProviderJson(
        fetchImpl,
        "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
        accessToken,
      );
      return me?.mail ?? me?.userPrincipalName ?? null;
    },
  };
}

export function createHandler(options = {}) {
  const {
    getStateStore = getDefaultStateStore,
    getConnectionStore = getDefaultConnectionStore,
    getMembershipStore = getDefaultMembershipStore,
    getInviteStore = getDefaultInviteStore,
    getWorkspaceStore = getDefaultWorkspaceStore,
    getOAuthSecret = getDefaultOAuthSecret,
    getTokenCrypto = getDefaultTokenCrypto,
    getProviderClient = (provider) => createProviderClient(provider),
    redirectBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL,
    appUrl = process.env.APP_URL,
    stateTtlSeconds = Number(process.env.OAUTH_STATE_TTL_SECONDS) ||
      DEFAULT_STATE_TTL_SECONDS,
    inviteTtlDays = Number(process.env.CALENDAR_INVITE_TTL_DAYS) ||
      DEFAULT_INVITE_TTL_DAYS,
    now = Date.now,
    randomState = () => randomBytes(32).toString("base64url"),
  } = options;

  async function requireAdminIdentity(event, membershipStore) {
    const identity = await resolveIdentity(event, membershipStore);
    if (!identity) throw new OAuthRequestError("Unauthorized", 401, "unauthorized");
    if (!isWorkspaceAdmin(identity)) {
      throw new OAuthRequestError(
        "Only a workspace administrator can manage calendar invitations",
        403,
        "forbidden",
      );
    }
    return identity;
  }

  return async function handle(event) {
    const method = event?.requestContext?.http?.method;
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
    const startMatch = path.match(/^\/oauth\/([^/]+)\/start$/);
    const callbackMatch = path.match(/^\/oauth\/([^/]+)\/callback$/);

    try {
      if (method === "GET" && startMatch) {
        const provider = requireProvider(startMatch[1]);
        const identity = await resolveIdentity(event, await getMembershipStore());
        if (!identity) return json(401, { message: "Unauthorized" });
        const baseUrl = requireAbsoluteUrl(redirectBaseUrl, "OAuth redirect base URL");
        const callbackUri = `${baseUrl}/oauth/${provider}/callback`;
        const secret = await loadProviderSecret(getOAuthSecret, provider);
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

          const secret = await loadProviderSecret(getOAuthSecret, provider);
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
          // Auto-select the primary calendar (falls back to the first, throws
          // no_calendars if the list is empty). The connection is then complete
          // and usable everywhere; the wizard's Connections step still lets the
          // customer switch to a different calendar afterwards.
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

          const accountEmail = await readAccountEmail(providerClient, {
            accessToken: tokens.accessToken,
            calendars,
          });
          const connectedAtIso = new Date(now()).toISOString();

          const connection = {
            workspaceId: stateRecord.workspaceId,
            provider,
            accountEmail,
            selectedCalendarId: selected?.id ?? null,
            calendarTimezone: selected?.timezone || "UTC",
            availableCalendars: calendars.map(toPublicCalendar),
            encryptedRefreshToken,
            tokenVersion,
            scopes: tokens.scopes.length > 0
              ? tokens.scopes
              : [...PROVIDERS[provider].scopes],
            connectionState: "connected",
            connectedAt: existing?.provider === provider && existing.connectedAt
              ? existing.connectedAt
              : connectedAtIso,
            lastSyncedAt: connectedAtIso,
            updatedAt: connectedAtIso,
            ...(provider === "microsoft-365-calendar" && tokens.tid
              ? { tid: tokens.tid }
              : {}),
          };
          await connectionStore.save(connection);
          // Records that the invited person finished, so the admin sees the
          // connection without ever handling their credentials. Done after the
          // connection is saved: a failure here must not lose the connection.
          if (stateRecord.inviteId) {
            try {
              await (await getInviteStore()).setStatus(
                stateRecord.inviteId,
                stateRecord.workspaceId,
                "completed",
                {
                  completedAt: connectedAtIso,
                  completedProvider: provider,
                  completedAccountEmail: accountEmail ?? "",
                },
              );
            } catch (error) {
              console.error("Calendar invite completion could not be recorded", {
                name: error?.name,
                message: error?.message,
              });
            }
          }
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

      if (path === "/calendars/invites" && method === "POST") {
        const identity = await requireAdminIdentity(event, await getMembershipStore());
        // A workspace books into exactly one calendar, so two people racing to
        // connect is meaningless - whoever finishes last would silently win.
        const existing = await (await getInviteStore())
          .listByWorkspace(identity.workspaceId);
        if (existing.some((invite) => inviteState(invite, now) === "pending")) {
          throw new OAuthRequestError(
            "An invitation is already open. Revoke it before creating another.",
            409,
            "invite_already_pending",
          );
        }
        const inviteId = randomState();
        const createdAt = new Date(now()).toISOString();
        const invite = {
          inviteId,
          workspaceId: identity.workspaceId,
          // Denormalised so the public landing page can name the company
          // without exposing the workspace record to an anonymous caller.
          workspaceName: await lookupWorkspaceName(
            await getWorkspaceStore(),
            identity.workspaceId,
          ),
          inviteeLabel: readInviteeLabel(readBody(event)),
          status: "pending",
          createdAt,
          createdByUserId: identity.userId,
          createdByName: identity.displayName,
          expiresAt: Math.floor(now() / 1000) + inviteTtlDays * 86_400,
        };
        await (await getInviteStore()).put(invite);
        return json(201, {
          ...toPublicInviteAdmin(invite),
          url: buildInviteUrl(appUrl, inviteId),
        });
      }

      if (path === "/calendars/invites" && method === "GET") {
        const identity = await requireAdminIdentity(event, await getMembershipStore());
        const invites = await (await getInviteStore())
          .listByWorkspace(identity.workspaceId);
        return json(200, {
          invites: invites
            .map((invite) => ({
              ...toPublicInviteAdmin(invite),
              url: buildInviteUrl(appUrl, invite.inviteId),
            }))
            .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "")),
        });
      }

      const inviteMatch = path.match(/^\/calendars\/invites\/([^/]+)$/);
      const inviteStartMatch = path.match(/^\/calendars\/invites\/([^/]+)\/start$/);
      const inviteRevokeMatch = path.match(/^\/calendars\/invites\/([^/]+)\/revoke$/);

      if (method === "POST" && inviteRevokeMatch) {
        const identity = await requireAdminIdentity(event, await getMembershipStore());
        const inviteId = requireInviteId(inviteRevokeMatch[1]);
        const revoked = await (await getInviteStore())
          .setStatus(inviteId, identity.workspaceId, "revoked", {
            revokedAt: new Date(now()).toISOString(),
          });
        if (!revoked) {
          throw new OAuthRequestError("Invite not found", 404, "invite_not_found");
        }
        return json(200, toPublicInviteAdmin(revoked));
      }

      // Permanent, and deliberately not available while an invitation is still
      // live: revoking first kills the link, so the record cannot be erased
      // while the link it represents still works.
      if (method === "DELETE" && inviteMatch) {
        const identity = await requireAdminIdentity(event, await getMembershipStore());
        const inviteId = requireInviteId(inviteMatch[1]);
        const store = await getInviteStore();
        const invite = await store.get(inviteId);
        if (!invite || invite.workspaceId !== identity.workspaceId) {
          throw new OAuthRequestError("Invite not found", 404, "invite_not_found");
        }
        if (inviteState(invite, now) === "pending") {
          throw new OAuthRequestError(
            "Revoke this invitation before deleting it",
            409,
            "invite_still_pending",
          );
        }
        await store.remove(inviteId, identity.workspaceId);
        return json(204, null);
      }

      // Public: the invitee has only the link, and must not need an account.
      if (method === "GET" && inviteMatch) {
        const inviteId = requireInviteId(inviteMatch[1]);
        const invite = await (await getInviteStore()).get(inviteId);
        const state = inviteState(invite, now);
        return json(state === "not_found" ? 404 : 200, {
          status: state,
          // Deliberately minimal: no workspace id, no creator identity.
          workspaceName: state === "pending" ? invite.workspaceName ?? null : null,
          providers: state === "pending" ? Object.keys(PROVIDERS) : [],
        });
      }

      if (method === "GET" && inviteStartMatch) {
        const inviteId = requireInviteId(inviteStartMatch[1]);
        const provider = requireProvider(event?.queryStringParameters?.provider);
        const invite = await (await getInviteStore()).get(inviteId);
        const state = inviteState(invite, now);
        if (state !== "pending") {
          throw new OAuthRequestError(
            "This invitation is no longer valid",
            410,
            `invite_${state}`,
          );
        }
        const baseUrl = requireAbsoluteUrl(redirectBaseUrl, "OAuth redirect base URL");
        const callbackUri = `${baseUrl}/oauth/${provider}/callback`;
        const secret = await loadProviderSecret(getOAuthSecret, provider);
        const oauthState = randomState();
        await (await getStateStore()).put({
          state: oauthState,
          workspaceId: invite.workspaceId,
          // consumeOAuthState requires a non-empty userId; an invited person may
          // have no account at all, so the invite itself is the identity.
          userId: `invite:${inviteId}`,
          inviteId,
          provider,
          redirectUri: callbackUri,
          // Fixed server-side rather than taken from the caller: this endpoint
          // is unauthenticated, so it must not accept a caller-chosen return.
          returnTo: `${INVITE_PATH_PREFIX}/${inviteId}`,
          expiresAt: Math.floor(now() / 1000) + stateTtlSeconds,
        });
        return json(200, {
          authorizeUrl: buildAuthorizationUrl({
            provider,
            clientId: secret.clientId,
            redirectUri: callbackUri,
            state: oauthState,
          }),
        });
      }

      if (path === "/calendars/connection" && method === "GET") {
        const identity = await resolveIdentity(event, await getMembershipStore());
        if (!identity) return json(401, { message: "Unauthorized" });
        const store = await getConnectionStore();
        return json(200, toPublicConnection(await store.get(identity.workspaceId)));
      }

      if (path === "/calendars/connection" && method === "DELETE") {
        const identity = await resolveIdentity(event, await getMembershipStore());
        if (!identity) return json(401, { message: "Unauthorized" });
        const store = await getConnectionStore();
        return json(200, toPublicConnection(await store.disconnect(identity.workspaceId)));
      }

      if (path === "/calendars/select" && method === "POST") {
        const identity = await resolveIdentity(event, await getMembershipStore());
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
        const secret = await loadProviderSecret(getOAuthSecret, provider);
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

// The account label is display-only: a provider hiccup reading it must never
// cost the customer the calendar connection they just authorized.
async function readAccountEmail(providerClient, input) {
  try {
    return await providerClient.getAccountEmail(input) ?? null;
  } catch {
    return null;
  }
}

function requireProvider(provider) {
  getProviderConfig(provider);
  return provider;
}

// The BFF resolves the caller's workspace through the workspace-memberships
// table (keyed by the Cognito `sub`), so a shared workspace is not the same
// string as the user id. This service must resolve it the same way, otherwise
// calendar connections get written under the raw `sub` while the BFF looks for
// them under the membership's workspaceId and never finds them.
async function resolveIdentity(event, membershipStore) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (typeof sub !== "string" || sub.length === 0) return null;
  const userId = claims?.username ??
    claims?.["cognito:username"] ??
    claims?.email ??
    sub;
  if (typeof userId !== "string" || userId.length === 0) return null;
  const roles = claimGroups(claims?.["cognito:groups"]);
  const displayName = typeof claims?.name === "string" && claims.name.trim()
    ? claims.name.trim()
    : userId;

  if (!membershipStore || typeof membershipStore.getMembership !== "function") {
    return { workspaceId: sub, userId, roles, displayName };
  }
  const membership = await membershipStore.getMembership(sub);
  if (!membership || membership.status === "disabled") return null;
  if (typeof membership.workspaceId !== "string" || membership.workspaceId.length === 0) {
    return null;
  }
  return { workspaceId: membership.workspaceId, userId, roles, displayName };
}

// Mirrors the BFF's parser: API Gateway exposes cognito:groups as an array, a
// JSON array string, or a bracketed comma-delimited string depending on setup.
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

function isWorkspaceAdmin(identity) {
  return identity.roles.some((role) => ADMIN_ROLES.has(role));
}

function requireInviteId(value) {
  if (typeof value !== "string" || !INVITE_ID_PATTERN.test(value)) {
    throw new OAuthRequestError("Invalid invitation", 404, "invite_not_found");
  }
  return value;
}

function readInviteeLabel(body) {
  const raw = body?.inviteeLabel;
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 200);
}

/** "pending" is the only state that may start an authorization. */
function inviteState(invite, now) {
  if (!invite) return "not_found";
  if (invite.status === "revoked") return "revoked";
  if (invite.status === "completed") return "completed";
  if (Number(invite.expiresAt) <= Math.floor(now() / 1000)) return "expired";
  return "pending";
}

function buildInviteUrl(appUrl, inviteId) {
  const base = requireAbsoluteUrl(appUrl, "App URL");
  return `${base}${INVITE_PATH_PREFIX}/${inviteId}`;
}

// Never exposes the raw invite token holder's identity beyond the workspace.
function toPublicInviteAdmin(invite) {
  return {
    inviteId: invite.inviteId,
    inviteeLabel: invite.inviteeLabel ?? "",
    status: invite.status,
    createdAt: invite.createdAt,
    createdByName: invite.createdByName ?? null,
    expiresAt: invite.expiresAt,
    completedAt: invite.completedAt ?? null,
    completedProvider: invite.completedProvider ?? null,
    completedAccountEmail: invite.completedAccountEmail ?? null,
  };
}

async function lookupWorkspaceName(workspaceStore, workspaceId) {
  if (!workspaceStore?.getWorkspace) return null;
  try {
    const workspace = await workspaceStore.getWorkspace(workspaceId);
    return typeof workspace?.name === "string" ? workspace.name : null;
  } catch {
    // A missing display name must not block issuing the invitation.
    return null;
  }
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
    // The invite landing page is public, so its path carries the invite id.
    // Constrained to the id character set so it cannot smuggle a longer path.
    const inviteReturn = parsed.pathname.startsWith(`${INVITE_PATH_PREFIX}/`) &&
      INVITE_ID_PATTERN.test(parsed.pathname.slice(INVITE_PATH_PREFIX.length + 1));
    const allowedPath = parsed.pathname === DEFAULT_RETURN_TO ||
      parsed.pathname === "/integrations" ||
      inviteReturn;
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

// Terraform creates an empty secret shell for every provider, so "credentials
// were never filled in" is a normal setup state, not a server fault. Report it
// as something an administrator can act on instead of a blank 500.
async function loadProviderSecret(getOAuthSecret, provider) {
  let secret;
  try {
    secret = await getOAuthSecret(provider);
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") {
      throw providerNotConfigured(provider, error);
    }
    throw error;
  }
  try {
    return normalizeSecret(secret);
  } catch (error) {
    throw providerNotConfigured(provider, error);
  }
}

function providerNotConfigured(provider, cause) {
  console.error("Calendar provider is not configured", {
    provider,
    name: cause?.name,
    message: cause?.message,
  });
  return new OAuthRequestError(
    `${PROVIDER_LABELS[provider] ?? provider} is not set up yet. ` +
      "Ask your administrator to finish configuring it.",
    503,
    "provider_not_configured",
  );
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

function toPublicCalendar(calendar) {
  return {
    id: calendar.id,
    name: calendar.name ?? calendar.id,
    timezone: calendar.timezone || "UTC",
    primary: calendar.primary === true,
  };
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
    availableCalendars: Array.isArray(record.availableCalendars)
      ? record.availableCalendars.map((calendar) => ({ ...calendar }))
      : record.availableCalendars,
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
          "calendarTimezone = :timezone, connectionState = :connected, " +
          "lastSyncedAt = :updatedAt, updatedAt = :updatedAt",
        ConditionExpression: "provider = :provider AND connectionState = :connected",
        ExpressionAttributeValues: marshall({
          ":calendarId": calendarId,
          ":timezone": calendarTimezone,
          ":connected": "connected",
          ":provider": provider,
          ":updatedAt": new Date().toISOString(),
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
let membershipStorePromise;
let inviteStorePromise;
let workspaceStorePromise;
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

// Returns null when the memberships table is not configured (e.g. unit tests),
// which makes resolveIdentity fall back to the raw Cognito sub.
async function getDefaultMembershipStore() {
  if (!process.env.WORKSPACE_MEMBERSHIPS_TABLE) return null;
  membershipStorePromise ??= getAwsRuntime().then(({ dynamodb, dynamoClient }) =>
    createDynamoMembershipStore(
      dynamoClient,
      dynamodb,
      process.env.WORKSPACE_MEMBERSHIPS_TABLE,
    ),
  );
  return membershipStorePromise;
}

async function getDefaultInviteStore() {
  inviteStorePromise ??= getAwsRuntime().then(({ dynamodb, dynamoClient }) => {
    if (!process.env.CALENDAR_INVITES_TABLE) {
      throw new Error("CALENDAR_INVITES_TABLE is required");
    }
    return createDynamoInviteStore(
      dynamoClient,
      dynamodb,
      process.env.CALENDAR_INVITES_TABLE,
    );
  });
  return inviteStorePromise;
}

// Read-only, and only for the workspace's display name on the invite page.
async function getDefaultWorkspaceStore() {
  if (!process.env.WORKSPACES_TABLE) return null;
  workspaceStorePromise ??= getAwsRuntime().then(({ dynamodb, dynamoClient }) => ({
    async getWorkspace(workspaceId) {
      const result = await dynamoClient.send(new dynamodb.GetItemCommand({
        TableName: process.env.WORKSPACES_TABLE,
        Key: marshall({ workspaceId }),
      }));
      return result.Item ? unmarshall(result.Item) : null;
    },
  }));
  return workspaceStorePromise;
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
