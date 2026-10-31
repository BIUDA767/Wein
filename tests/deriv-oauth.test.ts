import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  describeOAuthFailure,
  exchangeCodeForToken,
  generateCodeVerifier,
  generateState,
  OAuthError,
  DERIV_AUTH_ENDPOINT,
  DERIV_TOKEN_ENDPOINT,
} from "@phirst/brokers";

/**
 * Deriv OAuth 2.0 (Authorization Code + PKCE) conformance.
 *
 * The PKCE vector below is the canonical one from RFC 7636 Appendix B. Reproducing it
 * proves the challenge derivation matches the spec Deriv implements, rather than merely
 * being internally consistent.
 */

const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("Deriv OAuth — PKCE generation", () => {
  it("matches the RFC 7636 Appendix B challenge vector", () => {
    expect(deriveCodeChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  it("produces a code_verifier of 43–128 unreserved characters", () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("never repeats a verifier", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCodeVerifier());
    expect(seen.size).toBe(200);
  });

  it("derives a base64url challenge with no padding", () => {
    const challenge = deriveCodeChallenge(generateCodeVerifier());
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });

  it("is a real SHA-256 of the verifier", () => {
    const v = generateCodeVerifier();
    const expected = createHash("sha256").update(v, "utf8").digest("base64url");
    expect(deriveCodeChallenge(v)).toBe(expected);
  });
});

describe("Deriv OAuth — state generation", () => {
  it("produces a 32-character hex CSRF token", () => {
    const s = generateState();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never repeats a state", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateState());
    expect(seen.size).toBe(500);
  });
});

describe("Deriv OAuth — authorization URL", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "app12345",
      redirectUri: "https://wein.example/api/deriv/oauth/callback",
      scopes: "trade",
      state: "abc123",
      codeChallenge: RFC7636_CHALLENGE,
    }),
  );

  it("targets Deriv's authorization endpoint", () => {
    expect(`${url.origin}${url.pathname}`).toBe(DERIV_AUTH_ENDPOINT);
  });

  it("carries every required parameter", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app12345");
    expect(url.searchParams.get("redirect_uri")).toBe("https://wein.example/api/deriv/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("trade");
    expect(url.searchParams.get("state")).toBe("abc123");
    expect(url.searchParams.get("code_challenge")).toBe(RFC7636_CHALLENGE);
  });

  it("always declares the S256 challenge method", () => {
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("requests no account_manage or payment scope by default", () => {
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).not.toContain("account_manage");
    expect(scope).not.toContain("payment");
  });
});

describe("Deriv OAuth — token exchange", () => {
  const baseInput = {
    clientId: "app12345",
    code: "AUTH_CODE",
    codeVerifier: RFC7636_VERIFIER,
    redirectUri: "https://wein.example/api/deriv/oauth/callback",
  };

  it("POSTs form-encoded to the token endpoint and returns the token and lifetime", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ access_token: "ory_at_x", expires_in: 2592000, token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const token = await exchangeCodeForToken(baseInput);
      expect(token.accessToken).toBe("ory_at_x");
      expect(token.expiresIn).toBe(2592000);
      expect(capturedUrl).toBe(DERIV_TOKEN_ENDPOINT);
      expect(capturedInit?.method).toBe("POST");
      const body = String(capturedInit?.body);
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain(`code_verifier=${encodeURIComponent(RFC7636_VERIFIER)}`);
      expect(body).toContain("code=AUTH_CODE");
      expect(body).toContain("redirect_uri=");
      expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a response with no token lifetime, since expiry could not be tracked", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "ory_at_x", token_type: "Bearer" }), { status: 200 })) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      await expect(exchangeCodeForToken(baseInput)).rejects.toMatchObject({ code: "invalid_response" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("maps a provider invalid_grant to a stable message and keeps the body out of the error", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already used" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const err = (await exchangeCodeForToken(baseInput).catch((e) => e)) as OAuthError;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.code).toBe("invalid_grant");
      expect(err.message).toBe(describeOAuthFailure("invalid_grant"));
      expect(err.message).not.toContain("code already used");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports a network failure without leaking internals", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    }) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const err = (await exchangeCodeForToken(baseInput).catch((e) => e)) as OAuthError;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.code).toBe("network");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Deriv OAuth — failure descriptions", () => {
  it("explains a user cancellation", () => {
    expect(describeOAuthFailure("access_denied")).toMatch(/cancelled/i);
  });

  it("points an invalid_client at the client id", () => {
    expect(describeOAuthFailure("invalid_client")).toContain("DERIV_OAUTH_CLIENT_ID");
  });

  it("falls back to a generic message for an unknown code", () => {
    expect(describeOAuthFailure("something_new")).toMatch(/Deriv rejected/);
  });
});
