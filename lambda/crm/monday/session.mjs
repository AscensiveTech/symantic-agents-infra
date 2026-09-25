import { CRM_ERROR, CrmError } from "../errors.mjs";

const PROVIDER = "monday";
const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;
const REFRESH_LOCK_MS = 15_000;

/**
 * Opens authenticated sessions for Monday connections. Access tokens live an
 * hour and are stored encrypted on the connection row, so most invocations
 * never refresh. When one must, a short lock on the row serializes the
 * refresh across Lambda containers, and the write is a compare-and-swap on
 * tokenVersion: Monday rotates the refresh token on every use, so two
 * uncoordinated refreshes would leave one container holding a dead token.
 */
export function createMondaySessionFactory({
  connectionStore,
  tokenCrypto,
  oauthClient,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  metrics,
}) {
  const cache = new Map();

  function cacheKey(connection) {
    return `${connection.workspaceId}\0${connection.tokenVersion}`;
  }

  async function decryptAccess(connection) {
    return tokenCrypto.decrypt({
      ciphertext: connection.encryptedAccessToken,
      workspaceId: connection.workspaceId,
      provider: PROVIDER,
      purpose: "access",
    });
  }

  async function reauth(connection, reason) {
    metrics?.count("TokenFailure", { Provider: PROVIDER, Outcome: reason });
    await connectionStore.markReauthRequired(connection.workspaceId, PROVIDER, reason)
      .catch(() => {});
    return new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Monday authorization must be renewed");
  }

  async function useStored(connection) {
    const accessToken = await decryptAccess(connection);
    cache.set(cacheKey(connection), {
      accessToken,
      expiresAt: Number(connection.accessTokenExpiresAt),
    });
    return accessToken;
  }

  async function refresh(connection, { waitMs }) {
    const nowMs = Number(now());
    const locked = await connectionStore.acquireRefreshLock(
      connection.workspaceId,
      PROVIDER,
      connection.tokenVersion,
      nowMs + REFRESH_LOCK_MS,
    );
    if (!locked) {
      // Another container is refreshing (or already did). Wait for the new
      // version to land rather than burning our copy of the refresh token.
      const deadline = nowMs + waitMs;
      while (Number(now()) < deadline) {
        await sleep(250);
        const latest = await connectionStore.getConnection(connection.workspaceId, PROVIDER);
        if (!latest || latest.connectionState !== "connected") {
          throw new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Monday authorization must be renewed");
        }
        if (latest.tokenVersion !== connection.tokenVersion) return useStored(latest);
      }
      if (Number(connection.accessTokenExpiresAt) > Number(now())) return useStored(connection);
      throw new CrmError(CRM_ERROR.CONFLICT, "Monday token refresh in progress", {
        retryAfterSeconds: 5,
      });
    }

    let tokens;
    try {
      const refreshToken = await tokenCrypto.decrypt({
        ciphertext: connection.encryptedRefreshToken,
        workspaceId: connection.workspaceId,
        provider: PROVIDER,
        purpose: "refresh",
      });
      tokens = await oauthClient.refresh({
        refreshToken,
        authorizedAt: connection.authorizedAt ? Date.parse(connection.authorizedAt) : Number(now()),
      });
    } catch (error) {
      await connectionStore.releaseRefreshLock(connection.workspaceId, PROVIDER).catch(() => {});
      if (error instanceof CrmError && error.code === CRM_ERROR.REAUTH_REQUIRED) {
        // A container that won an earlier race may have rotated the token
        // after we read the row - that is not a revocation.
        const latest = await connectionStore.getConnection(connection.workspaceId, PROVIDER);
        if (latest?.connectionState === "connected" && latest.tokenVersion !== connection.tokenVersion) {
          return useStored(latest);
        }
        throw await reauth(connection, "refresh_rejected");
      }
      metrics?.count("TokenFailure", { Provider: PROVIDER, Outcome: "refresh_unavailable" });
      throw error;
    }

    const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
      tokenCrypto.encrypt({
        plaintext: tokens.accessToken,
        workspaceId: connection.workspaceId,
        provider: PROVIDER,
        purpose: "access",
      }),
      tokenCrypto.encrypt({
        plaintext: tokens.refreshToken,
        workspaceId: connection.workspaceId,
        provider: PROVIDER,
        purpose: "refresh",
      }),
    ]);
    const saved = await connectionStore.saveRefreshedTokens({
      workspaceId: connection.workspaceId,
      provider: PROVIDER,
      expectedVersion: connection.tokenVersion,
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
    metrics?.count("TokenRefresh", { Provider: PROVIDER, Outcome: saved ? "ok" : "lost_race" });
    if (!saved) {
      const latest = await connectionStore.getConnection(connection.workspaceId, PROVIDER);
      if (latest?.connectionState === "connected") return useStored(latest);
      throw new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Monday authorization must be renewed");
    }
    cache.set(`${saved.workspaceId}\0${saved.tokenVersion}`, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
    });
    return tokens.accessToken;
  }

  async function accessTokenFor(connection, { forceRefresh = false, waitMs = 3_000 } = {}) {
    if (connection?.connectionState === "reauth_required") {
      throw new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Monday authorization must be renewed");
    }
    if (connection?.connectionState !== "connected" || !connection.encryptedRefreshToken) {
      throw new CrmError(CRM_ERROR.NOT_CONNECTED, "Monday is not connected");
    }
    const nowMs = Number(now());
    if (Number(connection.refreshTokenExpiresAt) <= nowMs) {
      throw await reauth(connection, "authorization_expired");
    }
    if (!forceRefresh) {
      const cached = cache.get(cacheKey(connection));
      if (cached && cached.expiresAt - ACCESS_TOKEN_SKEW_MS > nowMs) return cached.accessToken;
      if (
        connection.encryptedAccessToken &&
        Number(connection.accessTokenExpiresAt) - ACCESS_TOKEN_SKEW_MS > nowMs
      ) {
        return useStored(connection);
      }
    } else {
      cache.delete(cacheKey(connection));
    }
    return refresh(connection, { waitMs });
  }

  return {
    /**
     * Run `operation(session)` with a valid token. A 401 gets exactly one
     * forced refresh and retry; a second 401 means the grant is gone.
     */
    async withSession(connection, operation, { waitMs } = {}) {
      const mapping = connection.mapping ?? null;
      let accessToken = await accessTokenFor(connection, { waitMs });
      try {
        return await operation({ accessToken, mapping });
      } catch (error) {
        if (!(error instanceof CrmError) || error.code !== CRM_ERROR.UNAUTHORIZED) throw error;
      }
      const latest = await connectionStore.getConnection(connection.workspaceId, PROVIDER) ?? connection;
      // If someone else rotated the token since we read the row, their new
      // access token is the one to try - refreshing again would be wasted.
      accessToken = await accessTokenFor(latest, {
        forceRefresh: latest.tokenVersion === connection.tokenVersion,
        waitMs,
      });
      try {
        return await operation({ accessToken, mapping: latest.mapping ?? mapping });
      } catch (error) {
        if (error instanceof CrmError && error.code === CRM_ERROR.UNAUTHORIZED) {
          throw await reauth(connection, "repeated_401");
        }
        throw error;
      }
    },
    accessTokenFor,
  };
}
