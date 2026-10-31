import { createHash, randomBytes } from "node:crypto";

/**
 * Deriv OAuth 2.0 — Authorization Code flow with PKCE (S256).
 *
 * Reference: https://developers.deriv.com/docs/intro/oauth/
 *
 * Only the two request shapes Deriv documents are implemented: the authorization URL the
 * browser is sent to, and the server-side form-encoded token exchange. The token exchange
 * must never happen in the browser, so nothing here is exported to the web bundle.
 */

/** Deriv's authorization endpoint. The user authenticates on Deriv's own pages. */
export const DERIV_AUTH_ENDPOINT = "https://auth.deriv.com/oauth2/auth";
/** Deriv's token endpoint. Called from the backend only. */
export const DERIV_TOKEN_ENDPOINT = "https://auth.deriv.com/oauth2/token";
/** REST base for account reads and OTP generation. */
export const DERIV_API_BASE = "https://api.derivws.com";

/**
 * The character set PKCE allows for a `code_verifier`: unreserved URL characters.
 * A random byte is mapped onto it by modulo, exactly as Deriv's own example does.
 */
const VERIFIER_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * A `code_verifier` must be 43–128 characters. 64 random bytes mapped onto the 66-character
 * unreserved set yields 64 characters, comfortably inside the range with ~384 bits of entropy.
 */
export function generateCodeVerifier(): string {
  const bytes = randomBytes(64);
  let out = "";
  for (const b of bytes) out += VERIFIER_CHARSET[b % VERIFIER_CHARSET.length];
  return out;
}

/** `code_challenge = BASE64URL(SHA256(code_verifier))` with no padding. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

/** A fresh CSRF `state` for every authorization request. 32 hex characters. */
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
}

/**
 * Build the authorization URL. `response_type=code` and `code_challenge_method=S256` are
 * fixed because that is the only flow this app implements.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(DERIV_AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  /** Seconds until the token expires, as returned by Deriv. Never assumed. */
  expiresIn: number;
  tokenType: string;
  scope: string | null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface ExchangeCodeInput {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Exchange an authorization code for an access token. Form-encoded POST to Deriv's token
 * endpoint. Deriv returns no refresh token, so only the access token and its lifetime are
 * carried forward. The provider's error body is logged but never returned to a caller that
 * might surface it to a user.
 */
export async function exchangeCodeForToken(input: ExchangeCodeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  });

  let res: Response;
  try {
    res = await fetch(DERIV_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthError(`Could not reach Deriv's token endpoint: ${(err as Error).message}`, "network", 0);
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  if (!res.ok) {
    const code = String(parsed.error ?? `http_${res.status}`);
    const description = String(parsed.error_description ?? "");
    input.log?.("deriv oauth token exchange failed", { status: res.status, code, description, body: text.slice(0, 500) });
    // Surface a stable, non-leaking message. The provider body stays in the log.
    throw new OAuthError(describeOAuthFailure(code), code, res.status);
  }

  const accessToken = parsed.access_token;
  const expiresIn = parsed.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("Deriv returned no access token.", "invalid_response", res.status);
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError("Deriv returned no token lifetime, so expiry cannot be tracked.", "invalid_response", res.status);
  }

  return {
    accessToken,
    expiresIn,
    tokenType: String(parsed.token_type ?? "Bearer"),
    scope: typeof parsed.scope === "string" ? parsed.scope : null,
  };
}

/** Map an OAuth error code to a message safe to show a user. */
export function describeOAuthFailure(code: string): string {
  switch (code) {
    case "access_denied":
      return "Authorization was cancelled at Deriv. Nothing was connected.";
    case "invalid_grant":
      return "Deriv rejected the authorization code. It may have expired or already been used. Try connecting again.";
    case "invalid_client":
      return "Deriv did not recognise this application. Check DERIV_OAUTH_CLIENT_ID.";
    case "invalid_request":
      return "Deriv rejected the authorization request. Check the registered redirect URI matches exactly.";
    case "unsupported_response_type":
    case "unsupported_grant_type":
      return "Deriv does not support this authorization flow for this application.";
    case "temporarily_unavailable":
      return "Deriv's authorization service is temporarily unavailable. Try again shortly.";
    default:
      return `Deriv rejected the authorization (${code}).`;
  }
}
