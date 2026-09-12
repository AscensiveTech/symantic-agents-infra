import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthorizationUrl,
  configureMicrosoftRotationForTests,
  consumeOAuthState,
  createHandler,
  createInMemoryConnectionStore,
  createInMemoryInviteStore,
  createInMemoryMembershipStore,
  createInMemoryStateStore,
  createProviderClient,
  decryptRefreshToken,
  encryptRefreshToken,
  rotateMicrosoftToken,
} from "./index.mjs";
import {
  cancelBooking,
  createBooking,
  getAvailability,
  rescheduleBooking,
} from "./calendar-adapter.mjs";

const workspaceId = "workspace-123";
const redirectUri = "https://api.example.com/oauth/google-calendar/callback";

test("google start URL requests offline calendar access and explicit consent", () => {
  const url = new URL(buildAuthorizationUrl({
    provider: "google-calendar",
    clientId: "google-client",
    redirectUri,
    state: "state-123",
  }));

  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "google-client");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.deepEqual(new Set(url.searchParams.get("scope").split(" ")), new Set([
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ]));
});

test("microsoft start URL uses organizations and required calendar scopes", () => {
  const url = new URL(buildAuthorizationUrl({
    provider: "microsoft-365-calendar",
    clientId: "microsoft-client",
    redirectUri: "https://api.example.com/oauth/microsoft-365-calendar/callback",
    state: "state-456",
  }));

  assert.equal(
    url.origin + url.pathname,
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  );
  assert.deepEqual(new Set(url.searchParams.get("scope").split(" ")), new Set([
    "offline_access",
    "User.Read",
    "Calendars.ReadWrite",
  ]));
});

test("microsoft calendar listing stays within Calendars.ReadWrite scope", async () => {
  const requests = [];
  const providerClient = createProviderClient("microsoft-365-calendar", {
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify({
        value: [{
          id: "calendar-a",
          name: "Primary",
          isDefaultCalendar: true,
          canEdit: true,
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const calendars = await providerClient.listCalendars({ accessToken: "access-token" });

  assert.deepEqual(requests, [
    "https://graph.microsoft.com/v1.0/me/calendars" +
      "?$select=id,name,isDefaultCalendar,canEdit",
  ]);
  assert.deepEqual(calendars, [{
    id: "calendar-a",
    name: "Primary",
    timezone: "UTC",
    primary: true,
  }]);
});

test("google reads the connected account from the primary calendar, not a userinfo scope", async () => {
  const requests = [];
  const providerClient = createProviderClient("google-calendar", {
    fetchImpl: async (url) => {
      requests.push(url);
      throw new Error("Google must not make a network call for the account email");
    },
  });

  const accountEmail = await providerClient.getAccountEmail({
    accessToken: "access-token",
    calendars: [
      { id: "shared@example.com", primary: false },
      { id: "owner@example.com", primary: true },
    ],
  });

  assert.equal(accountEmail, "owner@example.com");
  assert.deepEqual(requests, []);
});

test("microsoft reads the connected account from the profile it already has scope for", async () => {
  const requests = [];
  const providerClient = createProviderClient("microsoft-365-calendar", {
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(
        JSON.stringify({ mail: "owner@example.com", userPrincipalName: "owner@tenant" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const accountEmail = await providerClient.getAccountEmail({ accessToken: "access-token" });

  assert.equal(accountEmail, "owner@example.com");
  assert.deepEqual(requests, [
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
  ]);
});

test("refresh tokens round-trip through KMS with workspace and provider context", async () => {
  class EncryptCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class DecryptCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const contexts = [];
  const kms = {
    async send(command) {
      contexts.push(command.input.EncryptionContext);
      if (command instanceof EncryptCommand) {
        return { CiphertextBlob: Uint8Array.from(command.input.Plaintext).reverse() };
      }
      return { Plaintext: Uint8Array.from(command.input.CiphertextBlob).reverse() };
    },
  };
  const dependencies = {
    client: kms,
    EncryptCommand,
    DecryptCommand,
    keyId: "alias/symantic-dev-calendar-tokens",
  };

  const encrypted = await encryptRefreshToken({
    token: "refresh-token",
    workspaceId,
    provider: "google-calendar",
  }, dependencies);
  const decrypted = await decryptRefreshToken({
    encryptedToken: encrypted,
    workspaceId,
    provider: "google-calendar",
  }, dependencies);

  assert.equal(decrypted, "refresh-token");
  assert.deepEqual(contexts, [
    { workspaceId, provider: "google-calendar" },
    { workspaceId, provider: "google-calendar" },
  ]);
});

test("microsoft refresh replaces token only if version matches", async () => {
  const store = createInMemoryConnectionStore([{
    workspaceId,
    provider: "microsoft-365-calendar",
    selectedCalendarId: "calendar-a",
    calendarTimezone: "UTC",
    encryptedRefreshToken: "encrypted:a",
    tokenVersion: 1,
    scopes: ["offline_access", "User.Read", "Calendars.ReadWrite"],
    connectionState: "connected",
  }]);
  configureMicrosoftRotationForTests({
    store,
    encryptToken: async ({ token }) => `encrypted:${token}`,
  });

  await assert.doesNotReject(async () => {
    const result = await rotateMicrosoftToken({
      workspaceId,
      expectedVersion: 1,
      newToken: "b",
    });
    assert.equal(result.tokenVersion, 2);
  });
  await assert.rejects(
    rotateMicrosoftToken({ workspaceId, expectedVersion: 1, newToken: "c" }),
    /version/i,
  );
});

test("oauth state is one-time and rejects reuse", async () => {
  const stateStore = createInMemoryStateStore();
  await stateStore.put({
    state: "one-time-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_900_000_000,
  });

  const consumed = await consumeOAuthState({
    state: "one-time-state",
    provider: "google-calendar",
    redirectUri,
    stateStore,
    now: () => 1_800_000_000_000,
  });

  assert.equal(consumed.workspaceId, workspaceId);
  assert.equal(consumed.userId, "person@example.com");
  await assert.rejects(
    consumeOAuthState({
      state: "one-time-state",
      provider: "google-calendar",
      redirectUri,
      stateStore,
      now: () => 1_800_000_000_000,
    }),
    /state/i,
  );
});

test("oauth state rejects expired records and redirect mismatches", async () => {
  const expiredStore = createInMemoryStateStore();
  await expiredStore.put({
    state: "expired-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_700_000_000,
  });
  await assert.rejects(
    consumeOAuthState({
      state: "expired-state",
      provider: "google-calendar",
      redirectUri,
      stateStore: expiredStore,
      now: () => 1_800_000_000_000,
    }),
    /expired/i,
  );

  const redirectStore = createInMemoryStateStore();
  await redirectStore.put({
    state: "redirect-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_900_000_000,
  });
  await assert.rejects(
    consumeOAuthState({
      state: "redirect-state",
      provider: "google-calendar",
      redirectUri: "https://attacker.example.com/callback",
      stateStore: redirectStore,
      now: () => 1_800_000_000_000,
    }),
    /redirect/i,
  );
});

test("start requires JWT claims and returns a provider authorization URL", async () => {
  const stateStore = createInMemoryStateStore();
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
    randomState: () => "random-state",
  });

  const unauthorized = await handler(event("GET", "/oauth/google-calendar/start"));
  assert.equal(unauthorized.statusCode, 401);

  const response = await handler(authenticatedEvent(
    "GET",
    "/oauth/google-calendar/start",
    undefined,
    { returnTo: "/agents/new/connections?agentId=agent-1" },
  ));
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(new URL(body.authorizeUrl).searchParams.get("state"), "random-state");
  const stored = await stateStore.peek("random-state");
  assert.deepEqual(stored, {
    state: "random-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections?agentId=agent-1",
    expiresAt: 1_800_000_600,
  });
});

test("start resolves the shared workspace from the memberships table, not the raw sub", async () => {
  const stateStore = createInMemoryStateStore();
  const membershipStore = createInMemoryMembershipStore([
    { userId: workspaceId, workspaceId: "workspace-symantic-ai", status: "active" },
  ]);
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getMembershipStore: async () => membershipStore,
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
    randomState: () => "membership-state",
  });

  const response = await handler(authenticatedEvent("GET", "/oauth/google-calendar/start"));
  assert.equal(response.statusCode, 200);
  const stored = await stateStore.peek("membership-state");
  assert.equal(stored.workspaceId, "workspace-symantic-ai");
  assert.equal(stored.userId, "person@example.com");
});

test("start rejects a caller with no active membership when the memberships table is configured", async () => {
  const handler = createHandler({
    getStateStore: async () => createInMemoryStateStore(),
    getMembershipStore: async () => createInMemoryMembershipStore([
      { userId: workspaceId, workspaceId: "workspace-symantic-ai", status: "disabled" },
    ]),
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
  });

  const response = await handler(authenticatedEvent("GET", "/oauth/google-calendar/start"));
  assert.equal(response.statusCode, 401);
});

test("start preserves the safe integrations return route", async () => {
  const stateStore = createInMemoryStateStore();
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
    randomState: () => "integrations-state",
  });

  const response = await handler(authenticatedEvent(
    "GET",
    "/oauth/microsoft-365-calendar/start",
    undefined,
    { returnTo: "/integrations" },
  ));

  assert.equal(response.statusCode, 200);
  assert.equal(
    (await stateStore.peek("integrations-state")).returnTo,
    "/integrations",
  );
});

// Terraform creates an empty secret shell per provider, so an unconfigured
// provider is a normal setup state. It surfaced as a blank 500 in dev.
test("an unconfigured provider reports setup needed, not an internal error", async () => {
  const missingVersion = Object.assign(
    new Error("Secrets Manager can't find the specified secret value"),
    { name: "ResourceNotFoundException" },
  );
  const cases = [
    ["secret shell with no version", async () => { throw missingVersion; }],
    ["placeholder secret with no credentials", async () => ({})],
  ];

  for (const [label, getOAuthSecret] of cases) {
    const handler = createHandler({
      getStateStore: async () => createInMemoryStateStore(),
      getConnectionStore: async () => createInMemoryConnectionStore(),
      getOAuthSecret,
      redirectBaseUrl: "https://api.example.com",
      appUrl: "https://agents.example.com",
    });

    const response = await handler(
      authenticatedEvent("GET", "/oauth/microsoft-365-calendar/start"),
    );
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 503, label);
    assert.equal(body.code, "provider_not_configured", label);
    assert.match(body.message, /Microsoft 365 Calendar is not set up yet/);
  }
});

test("google callback preserves an existing refresh token when Google omits one", async () => {
  const stateStore = createInMemoryStateStore();
  await stateStore.put({
    state: "callback-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_900_000_000,
  });
  const connections = createInMemoryConnectionStore([{
    workspaceId,
    provider: "google-calendar",
    selectedCalendarId: "old-calendar",
    calendarTimezone: "UTC",
    encryptedRefreshToken: "encrypted:keep-me",
    tokenVersion: 4,
    scopes: ["old-scope"],
    connectionState: "connected",
  }]);
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getConnectionStore: async () => connections,
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    getTokenCrypto: async () => ({
      encryptToken: async () => {
        throw new Error("Google null refresh token must not be encrypted");
      },
      decryptToken: async () => "keep-me",
    }),
    getProviderClient: () => ({
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: null,
        scopes: ["new-scope"],
      }),
      listCalendars: async () => [{
        id: "primary-calendar",
        timezone: "America/New_York",
        primary: true,
      }],
    }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
  });

  const response = await handler(event(
    "GET",
    "/oauth/google-calendar/callback",
    undefined,
    { code: "authorization-code", state: "callback-state" },
  ));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://agents.example.com/agents/new/connections?calendar=connected&provider=google-calendar",
  );
  assert.deepEqual(await connections.get(workspaceId), {
    workspaceId,
    provider: "google-calendar",
    // This fake provider client predates getAccountEmail; the connection must
    // still be saved rather than lost over a display-only label.
    accountEmail: null,
    selectedCalendarId: "primary-calendar",
    calendarTimezone: "America/New_York",
    availableCalendars: [{
      id: "primary-calendar",
      name: "primary-calendar",
      timezone: "America/New_York",
      primary: true,
    }],
    encryptedRefreshToken: "encrypted:keep-me",
    tokenVersion: 4,
    scopes: ["new-scope"],
    connectionState: "connected",
    connectedAt: "2027-01-15T08:00:00.000Z",
    lastSyncedAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:00.000Z",
  });
});

test("callback auto-selects the primary calendar and still exposes the rest for switching", async () => {
  const stateStore = createInMemoryStateStore();
  await stateStore.put({
    state: "multi-calendar-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_900_000_000,
  });
  const connections = createInMemoryConnectionStore();
  const calendars = [
    {
      id: "calendar-a",
      name: "Front desk",
      timezone: "America/New_York",
      primary: true,
    },
    {
      id: "calendar-b",
      name: "Appointments",
      timezone: "America/Chicago",
      primary: false,
    },
  ];
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getConnectionStore: async () => connections,
    getOAuthSecret: async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
    }),
    getTokenCrypto: async () => ({
      encryptToken: async () => "encrypted-token",
      decryptToken: async () => "refresh-token",
    }),
    getProviderClient: () => ({
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        scopes: ["calendar"],
      }),
      listCalendars: async () => calendars,
    }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
  });

  const callback = await handler(event(
    "GET",
    "/oauth/google-calendar/callback",
    undefined,
    { code: "authorization-code", state: "multi-calendar-state" },
  ));
  const connection = await handler(authenticatedEvent(
    "GET",
    "/calendars/connection",
  ));

  assert.equal(callback.statusCode, 302);
  assert.deepEqual(JSON.parse(connection.body), {
    provider: "google-calendar",
    accountEmail: null,
    // Primary calendar auto-selected; the customer can still switch via
    // /calendars/select (covered separately) or the wizard's Connections step.
    selectedCalendarId: "calendar-a",
    calendarTimezone: "America/New_York",
    tokenVersion: 1,
    scopes: ["calendar"],
    connectionState: "connected",
    connectedAt: "2027-01-15T08:00:00.000Z",
    lastSyncedAt: "2027-01-15T08:00:00.000Z",
    updatedAt: "2027-01-15T08:00:00.000Z",
    availableCalendars: calendars,
  });
});

test("callback redirects post-consume failures to the app instead of JSON", async () => {
  const stateStore = createInMemoryStateStore();
  await stateStore.put({
    state: "fail-state",
    workspaceId,
    userId: "person@example.com",
    provider: "google-calendar",
    redirectUri,
    returnTo: "/agents/new/connections",
    expiresAt: 1_900_000_000,
  });
  const handler = createHandler({
    getStateStore: async () => stateStore,
    getConnectionStore: async () => createInMemoryConnectionStore(),
    getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
    getTokenCrypto: async () => ({
      encryptToken: async () => {
        throw new Error("missing refresh token must not be encrypted");
      },
      decryptToken: async () => "unused",
    }),
    getProviderClient: () => ({
      exchangeCode: async () => ({
        accessToken: "access-token",
        refreshToken: null,
        scopes: ["new-scope"],
      }),
      listCalendars: async () => [{
        id: "primary-calendar",
        timezone: "UTC",
        primary: true,
      }],
    }),
    redirectBaseUrl: "https://api.example.com",
    appUrl: "https://agents.example.com",
    now: () => 1_800_000_000_000,
  });

  const response = await handler(event(
    "GET",
    "/oauth/google-calendar/callback",
    undefined,
    { code: "authorization-code", state: "fail-state" },
  ));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://agents.example.com/agents/new/connections?calendar=error&reason=missing_refresh_token",
  );
  assert.equal(response.body, "");
  assert.equal(response.headers["content-type"], undefined);
});

test("calendar adapter preserves the Task 7 operation surface", () => {
  for (const operation of [
    getAvailability,
    createBooking,
    rescheduleBooking,
    cancelBooking,
  ]) {
    assert.equal(typeof operation, "function");
  }
});

// ---------------------------------------------------------------------------
// Calendar invitations: an admin issues a link, someone else authorizes their
// own calendar with it, and the admin only ever sees that it completed.
// ---------------------------------------------------------------------------

const inviteId = "invite-token-that-is-long-enough-abc";

function inviteHandler({
  invites = createInMemoryInviteStore(),
  stateStore = createInMemoryStateStore(),
  connections = createInMemoryConnectionStore(),
  now = () => 1_800_000_000_000,
} = {}) {
  return {
    invites,
    stateStore,
    connections,
    handler: createHandler({
      getStateStore: async () => stateStore,
      getConnectionStore: async () => connections,
      getInviteStore: async () => invites,
      getWorkspaceStore: async () => ({
        getWorkspace: async () => ({ workspaceId, name: "Arc Dental" }),
      }),
      getOAuthSecret: async () => ({ clientId: "client-id", clientSecret: "client-secret" }),
      getTokenCrypto: async () => ({
        encryptToken: async () => "encrypted-token",
        decryptToken: async () => "refresh-token",
      }),
      getProviderClient: () => ({
        exchangeCode: async () => ({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          scopes: ["calendar"],
        }),
        listCalendars: async () => [
          { id: "invitee@example.com", name: "Invitee", timezone: "UTC", primary: true },
        ],
        getAccountEmail: async ({ calendars }) => calendars.find((c) => c.primary)?.id ?? null,
      }),
      redirectBaseUrl: "https://api.example.com",
      appUrl: "https://agents.example.com",
      now,
    }),
  };
}

test("only a workspace admin can issue a calendar invitation", async () => {
  const { handler } = inviteHandler();

  const forbidden = await handler(authenticatedEvent("POST", "/calendars/invites", {}));
  const unauthorized = await handler(event("POST", "/calendars/invites", {}));

  assert.equal(forbidden.statusCode, 403);
  assert.equal(JSON.parse(forbidden.body).code, "forbidden");
  assert.equal(unauthorized.statusCode, 401);
});

test("an issued invitation returns a shareable link the admin can send by any means", async () => {
  const { handler, invites } = inviteHandler();

  const created = await handler(
    adminEvent("POST", "/calendars/invites", { inviteeLabel: "Front desk – Jane" }),
  );
  const body = JSON.parse(created.body);

  assert.equal(created.statusCode, 201);
  assert.equal(body.status, "pending");
  assert.equal(body.inviteeLabel, "Front desk – Jane");
  assert.equal(body.createdByName, "Dana Admin");
  assert.ok(body.url.startsWith("https://agents.example.com/connect-calendar/"));
  // The link is the credential, so it must not be a guessable id.
  assert.ok(body.url.split("/").pop().length >= 22);
  const stored = await invites.listByWorkspace(workspaceId);
  assert.equal(stored.length, 1);
});

test("the public invite page names the company without leaking workspace internals", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId,
    workspaceName: "Arc Dental",
    status: "pending",
    createdByUserId: "person@example.com",
    createdByName: "Dana Admin",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(event("GET", `/calendars/invites/${inviteId}`));
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "pending");
  assert.equal(body.workspaceName, "Arc Dental");
  assert.deepEqual(body.providers, ["google-calendar", "microsoft-365-calendar"]);
  assert.equal(body.workspaceId, undefined);
  assert.equal(body.createdByUserId, undefined);
  assert.equal(body.createdByName, undefined);
});

test("an invited authorization is bound to the inviting workspace and cannot be redirected elsewhere", async () => {
  const { handler, invites, stateStore } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId,
    status: "pending",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(event(
    "GET",
    `/calendars/invites/${inviteId}/start`,
    undefined,
    // This endpoint is unauthenticated, so a caller-supplied return must be ignored.
    { provider: "google-calendar", returnTo: "https://evil.example.com/steal" },
  ));
  const authorizeUrl = new URL(JSON.parse(response.body).authorizeUrl);
  const record = await stateStore.peek(authorizeUrl.searchParams.get("state"));

  assert.equal(response.statusCode, 200);
  assert.equal(record.workspaceId, workspaceId);
  assert.equal(record.inviteId, inviteId);
  assert.equal(record.returnTo, `/connect-calendar/${inviteId}`);
});

test("a revoked, completed, or expired invitation cannot start an authorization", async () => {
  const cases = [
    ["revoked", { status: "revoked", expiresAt: 1_900_000_000 }],
    ["completed", { status: "completed", expiresAt: 1_900_000_000 }],
    ["expired", { status: "pending", expiresAt: 1_000 }],
  ];
  for (const [expected, attributes] of cases) {
    const { handler, invites } = inviteHandler();
    await invites.put({ inviteId, workspaceId, ...attributes });

    const response = await handler(event(
      "GET",
      `/calendars/invites/${inviteId}/start`,
      undefined,
      { provider: "google-calendar" },
    ));

    assert.equal(response.statusCode, 410, expected);
    assert.equal(JSON.parse(response.body).code, `invite_${expected}`);
  }
});

test("completing an invitation connects the calendar and reports back to the admin", async () => {
  const { handler, invites, stateStore, connections } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId,
    status: "pending",
    createdByName: "Dana Admin",
    expiresAt: 1_900_000_000,
  });
  await stateStore.put({
    state: "invited-state",
    workspaceId,
    userId: `invite:${inviteId}`,
    inviteId,
    provider: "google-calendar",
    redirectUri,
    returnTo: `/connect-calendar/${inviteId}`,
    expiresAt: 1_900_000_000,
  });

  const callback = await handler(event(
    "GET",
    "/oauth/google-calendar/callback",
    undefined,
    { code: "authorization-code", state: "invited-state" },
  ));
  const connection = await connections.get(workspaceId);
  const listed = JSON.parse(
    (await handler(adminEvent("GET", "/calendars/invites"))).body,
  ).invites[0];

  assert.equal(callback.statusCode, 302);
  assert.equal(
    callback.headers.location,
    `https://agents.example.com/connect-calendar/${inviteId}?calendar=connected&provider=google-calendar`,
  );
  // The invitee's calendar is attached to the workspace that invited them.
  assert.equal(connection.workspaceId, workspaceId);
  assert.equal(connection.accountEmail, "invitee@example.com");
  assert.equal(listed.status, "completed");
  assert.equal(listed.completedAccountEmail, "invitee@example.com");
  // The admin sees the outcome, never the invitee's tokens.
  assert.equal(listed.encryptedRefreshToken, undefined);
});

// The workspace books into exactly one calendar, so a second open invitation
// would just mean whoever finishes last silently wins the slot.
test("only one invitation can be open at a time", async () => {
  const { handler, invites } = inviteHandler();

  const first = await handler(adminEvent("POST", "/calendars/invites", { inviteeLabel: "Jane" }));
  const second = await handler(adminEvent("POST", "/calendars/invites", { inviteeLabel: "Sam" }));

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 409);
  assert.equal(JSON.parse(second.body).code, "invite_already_pending");
  assert.equal((await invites.listByWorkspace(workspaceId)).length, 1);
});

test("revoking frees the slot so a fresh invitation can be issued", async () => {
  const { handler } = inviteHandler();
  const created = JSON.parse(
    (await handler(adminEvent("POST", "/calendars/invites", {}))).body,
  );

  const revoked = await handler(
    adminEvent("POST", `/calendars/invites/${created.inviteId}/revoke`),
  );
  const replacement = await handler(adminEvent("POST", "/calendars/invites", {}));

  assert.equal(revoked.statusCode, 200);
  assert.equal(JSON.parse(revoked.body).status, "revoked");
  assert.equal(replacement.statusCode, 201);
});

test("an expired invitation does not keep the slot occupied", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({ inviteId, workspaceId, status: "pending", expiresAt: 1_000 });

  const response = await handler(adminEvent("POST", "/calendars/invites", {}));

  assert.equal(response.statusCode, 201);
});

test("deleting is refused while the invitation is still live", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId,
    status: "pending",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(adminEvent("DELETE", `/calendars/invites/${inviteId}`));

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).code, "invite_still_pending");
  // The record must survive, because its link is still usable.
  assert.ok(await invites.get(inviteId));
});

test("a revoked invitation can be deleted for good", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId,
    status: "revoked",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(adminEvent("DELETE", `/calendars/invites/${inviteId}`));

  assert.equal(response.statusCode, 204);
  assert.equal(await invites.get(inviteId), null);
});

test("an admin cannot delete another workspace's invitation", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId: "someone-elses-workspace",
    status: "revoked",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(adminEvent("DELETE", `/calendars/invites/${inviteId}`));

  assert.equal(response.statusCode, 404);
  assert.ok(await invites.get(inviteId));
});

test("an admin cannot revoke another workspace's invitation", async () => {
  const { handler, invites } = inviteHandler();
  await invites.put({
    inviteId,
    workspaceId: "someone-elses-workspace",
    status: "pending",
    expiresAt: 1_900_000_000,
  });

  const response = await handler(
    adminEvent("POST", `/calendars/invites/${inviteId}/revoke`),
  );

  assert.equal(response.statusCode, 404);
  assert.equal((await invites.get(inviteId)).status, "pending");
});

function event(method, path, body, queryStringParameters) {
  return {
    requestContext: { http: { method, path } },
    rawPath: path,
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters,
  };
}

function adminEvent(method, path, body, queryStringParameters) {
  const value = authenticatedEvent(method, path, body, queryStringParameters);
  value.requestContext.authorizer.jwt.claims["cognito:groups"] = "[company-admin]";
  value.requestContext.authorizer.jwt.claims.name = "Dana Admin";
  return value;
}

function authenticatedEvent(method, path, body, queryStringParameters) {
  const value = event(method, path, body, queryStringParameters);
  value.requestContext.authorizer = {
    jwt: {
      claims: {
        sub: workspaceId,
        email: "person@example.com",
      },
    },
  };
  return value;
}
