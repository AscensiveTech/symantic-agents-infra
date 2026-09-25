import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { CRM_ERROR, CrmError } from "../errors.mjs";

// Monday's OAuth 2.1 flow (the only one that works after 2026-10-01): PKCE
// S256, one-hour JWT access tokens, rotating refresh tokens, and a hard
// six-month ceiling from the original consent after which the user must
// authorize again.
const MONDAY_AUTHORIZE_URL = "https://auth.monday.com/oauth2/authorize";
const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth_ms/oauth/token";
const MONDAY_REVOKE_URL = "https://auth.monday.com/oauth_ms/oauth/revoke";

// Least privilege: read/write items on the mapped board, post item updates,
// read people (owner names) and the connecting account. No webhooks:write -
// the integration does not subscribe to board events.
export const MONDAY_SCOPES = Object.freeze([
  "me:read",
  "account:read",
  "boards:read",
  "boards:write",
  "updates:write",
  "users:read",
]);

const REFRESH_TOKEN_MAX_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

export function createPkcePair(random = () => randomBytes(48)) {
  const verifier = Buffer.from(random()).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL(MONDAY_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MONDAY_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function createMondayOAuthClient({
  fetchImpl = globalThis.fetch,
  getAppSecret,
  now = Date.now,
  timeoutMs = 8_000,
}) {
  async function post(url, body, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new CrmError(
          controller.signal.aborted ? CRM_ERROR.TIMEOUT : CRM_ERROR.TRANSIENT,
          `Monday ${operation} request failed`,
        );
      }
      let value = null;
      try {
        value = await response.json();
      } catch {
        value = null;
      }
      if (response.ok) return value ?? {};
      if (response.status >= 500 || response.status === 429) {
        throw new CrmError(
          response.status === 429 ? CRM_ERROR.RATE_LIMITED : CRM_ERROR.TRANSIENT,
          `Monday ${operation} unavailable`,
          { statusCode: response.status, retryAfterSeconds: 30 },
        );
      }
      // invalid_grant, revoked, expired, or a consumed rotating token: only a
      // fresh authorization fixes any of these.
      throw new CrmError(CRM_ERROR.REAUTH_REQUIRED, `Monday ${operation} was rejected`, {
        statusCode: response.status,
        providerCode: typeof value?.error === "string" ? value.error : undefined,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeTokens(value, { authorizedAt }) {
    const accessToken = value?.access_token;
    const refreshToken = value?.refresh_token;
    if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) {
      throw new CrmError(CRM_ERROR.REAUTH_REQUIRED, "Monday did not return a token pair");
    }
    const nowMs = Number(now());
    const expiresIn = Number(value.expires_in);
    const accessTokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? nowMs + expiresIn * 1000
      : (jwtExpiryMs(accessToken) ?? nowMs + 55 * 60 * 1000);
    const refreshTokenExpiresAt = jwtExpiryMs(refreshToken) ??
      Number(authorizedAt) + REFRESH_TOKEN_MAX_LIFETIME_MS;
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      scopes: typeof value.scope === "string" ? value.scope.split(/[\s,]+/).filter(Boolean) : [],
    };
  }

  return {
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const secret = await getAppSecret();
      const value = await post(MONDAY_TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: secret.clientId,
        client_secret: secret.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }, "token exchange");
      return normalizeTokens(value, { authorizedAt: Number(now()) });
    },

    async refresh({ refreshToken, authorizedAt }) {
      const secret = await getAppSecret();
      const value = await post(MONDAY_TOKEN_URL, {
        grant_type: "refresh_token",
        client_id: secret.clientId,
        client_secret: secret.clientSecret,
        refresh_token: refreshToken,
      }, "token refresh");
      return normalizeTokens(value, { authorizedAt });
    },

    async revoke({ token, hint }) {
      const secret = await getAppSecret();
      await post(MONDAY_REVOKE_URL, {
        token,
        client_id: secret.clientId,
        client_secret: secret.clientSecret,
        token_type_hint: hint,
      }, "token revoke");
    },
  };
}

/** Decoded `exp` of a JWT in ms, without verifying it (our own token). */
function jwtExpiryMs(token) {
  const claims = decodeJwtPayload(token);
  const exp = Number(claims?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify an HS256 JWT that Monday puts in the Authorization header of
 * lifecycle webhooks (signed with the app's client secret). Returns the
 * claims, or null for anything that does not verify.
 */
export function verifyMondayJwt(token, secret, { now = Date.now, leewaySeconds = 60 } = {}) {
  if (typeof token !== "string" || typeof secret !== "string" || !secret) return null;
  const raw = token.replace(/^Bearer\s+/i, "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let provided;
  try {
    provided = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  const claims = decodeJwtPayload(raw);
  if (!claims || typeof claims !== "object") return null;
  const nowSeconds = Number(now()) / 1000;
  if (claims.exp !== undefined && Number(claims.exp) + leewaySeconds < nowSeconds) return null;
  if (claims.nbf !== undefined && Number(claims.nbf) - leewaySeconds > nowSeconds) return null;
  return claims;
}
