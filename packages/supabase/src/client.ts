/**
 * Supabase client (Auth + REST) and a real JWKS-backed JWT verifier.
 *
 * Why this exists: Wein already has its own first-party session auth (cookie sessions,
 * scrypt passwords, AES-GCM vault). Supabase is added alongside it as an identity and
 * platform-data service, not as a replacement. This client therefore:
 *
 *  - verifies Supabase access tokens locally against the project's published JWKS
 *    (ES256/P-256) using node:crypto, so a forged token cannot be accepted;
 *  - keeps the service-role key strictly server-side and never sends it to the browser;
 *  - reports exactly which capabilities the configured keys enable, so the UI never
 *    offers a Supabase feature the project cannot actually perform.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import type { Logger } from "@phirst/core";

export interface SupabaseOptions {
  url: string | null;
  /** Public/anon (or publishable) key. Safe to expose to the browser. */
  anonKey: string | null;
  /** Service-role key. Server-only. Never logged, never returned to a client. */
  serviceRoleKey: string | null;
  /** JWKS URL; defaults to `${url}/auth/v1/.well-known/jwks.json`. */
  jwksUrl?: string | null;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export interface SupabaseStatus {
  configured: boolean;
  url: string | null;
  hasAnonKey: boolean;
  hasServiceRoleKey: boolean;
  jwksUrl: string | null;
  notes: string[];
}

export interface SupabaseUser {
  id: string;
  email: string | null;
  createdAt: string | null;
  emailConfirmedAt: string | null;
}

export interface JwtClaims {
  sub: string;
  email?: string;
  role?: string;
  exp?: number;
  aud?: string | string[];
  [k: string]: unknown;
}

export type SupabaseResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

interface JwksKey extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

function base64UrlToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export class SupabaseClient {
  private readonly fetchImpl: typeof fetch;
  private jwksCache: { at: number; keys: JwksKey[] } | null = null;

  constructor(private readonly opts: SupabaseOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.opts.url && (this.opts.anonKey || this.opts.serviceRoleKey));
  }

  private get baseUrl(): string {
    if (!this.opts.url) throw new Error("SUPABASE_URL is not configured");
    return this.opts.url.replace(/\/$/, "");
  }

  private get jwksUrl(): string {
    return this.opts.jwksUrl ?? `${this.baseUrl}/auth/v1/.well-known/jwks.json`;
  }

  status(): SupabaseStatus {
    const notes: string[] = [];
    if (!this.opts.url) notes.push("SUPABASE_URL is not configured.");
    else if (!this.opts.serviceRoleKey) {
      notes.push(
        "SUPABASE_SERVICE_ROLE_KEY is not configured. Token verification and public Auth work; privileged server operations are unavailable.",
      );
    } else {
      notes.push("Auth (GoTrue) and JWKS token verification are available. The service-role key is used server-side only.");
    }
    return {
      configured: this.available,
      url: this.opts.url,
      hasAnonKey: Boolean(this.opts.anonKey),
      hasServiceRoleKey: Boolean(this.opts.serviceRoleKey),
      jwksUrl: this.opts.url ? this.jwksUrl : null,
      notes,
    };
  }

  /**
   * Reachability and key probe. Distinguishes "the project is unreachable" from "the
   * project answered but rejected the key", because those need different fixes: a
   * rejected key means the URL and the keys belong to different Supabase projects.
   */
  async health(): Promise<{ ok: boolean; detail: string; keyRejected: boolean }> {
    if (!this.opts.url) return { ok: false, detail: "SUPABASE_URL is not configured", keyRejected: false };
    const key = this.opts.anonKey ?? this.opts.serviceRoleKey;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/auth/v1/health`, {
        headers: key ? { apikey: key } : {},
      });
      const text = await res.text();
      if (res.status === 401 || /invalid api key/i.test(text)) {
        return {
          ok: false,
          detail: "The Supabase API keys were rejected by this project. The URL and the keys appear to belong to different projects.",
          keyRejected: true,
        };
      }
      if (!res.ok) return { ok: false, detail: `Auth health HTTP ${res.status}`, keyRejected: false };
      let name = "GoTrue";
      let version = "";
      try {
        const body = JSON.parse(text) as { version?: string; name?: string };
        name = body.name ?? name;
        version = body.version ?? "";
      } catch {
        /* a non-JSON 200 still means the endpoint is up */
      }
      return { ok: true, detail: `${name} ${version}`.trim(), keyRejected: false };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, keyRejected: false };
    }
  }

  /** Probe the public JWKS endpoint, which needs no API key and proves the URL is live. */
  async jwksReachable(): Promise<{ ok: boolean; detail: string; keyCount: number }> {
    if (!this.opts.url) return { ok: false, detail: "SUPABASE_URL is not configured", keyCount: 0 };
    try {
      const keys = await this.fetchJwks();
      return { ok: true, detail: `${keys.length} signing key(s)`, keyCount: keys.length };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, keyCount: 0 };
    }
  }

  /** Fetch and cache the project JWKS. Cached for ten minutes; keys rotate rarely. */
  async fetchJwks(): Promise<JwksKey[]> {
    if (this.jwksCache && Date.now() - this.jwksCache.at < 600_000) return this.jwksCache.keys;
    const headers: Record<string, string> = {};
    if (this.opts.anonKey) headers.apikey = this.opts.anonKey;
    const res = await this.fetchImpl(this.jwksUrl, { headers });
    if (!res.ok) throw new Error(`Supabase JWKS HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: JwksKey[] };
    const keys = body.keys ?? [];
    if (keys.length === 0) throw new Error("Supabase JWKS returned no keys");
    this.jwksCache = { at: Date.now(), keys };
    return keys;
  }

  /**
   * Verify a Supabase access token against the project JWKS. Returns the claims on
   * success or null on any failure (bad structure, unknown kid, bad signature, expired).
   * The signature is checked with node:crypto; the token is never trusted unverified.
   */
  async verifyToken(token: string): Promise<JwtClaims | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: { alg?: string; kid?: string };
    let claims: JwtClaims;
    try {
      header = JSON.parse(base64UrlToBuffer(parts[0]!).toString("utf8")) as { alg?: string; kid?: string };
      claims = JSON.parse(base64UrlToBuffer(parts[1]!).toString("utf8")) as JwtClaims;
    } catch {
      return null;
    }
    if (header.alg !== "ES256" || !header.kid) return null;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
    let keys: JwksKey[];
    try {
      keys = await this.fetchJwks();
    } catch (err) {
      this.opts.log.warn("supabase jwks fetch failed", { error: (err as Error).message });
      return null;
    }
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    try {
      const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      const data = Buffer.from(`${parts[0]}.${parts[1]}`);
      const signature = base64UrlToBuffer(parts[2]!);
      const valid = cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
      return valid ? claims : null;
    } catch (err) {
      this.opts.log.warn("supabase token verification error", { error: (err as Error).message });
      return null;
    }
  }

  // --- Auth (public, anon key) -------------------------------------------------

  private async authRequest<T>(path: string, init: RequestInit, key: string | null): Promise<SupabaseResult<T>> {
    const apiKey = key;
    if (!apiKey) return { ok: false, error: "No Supabase API key is configured for this operation", status: 0 };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/auth/v1${path}`, {
        ...init,
        headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        const message = (parsed.msg ?? parsed.error_description ?? parsed.message ?? `HTTP ${res.status}`) as string;
        return { ok: false, error: `Supabase auth: ${message}`, status: res.status };
      }
      return { ok: true, value: parsed as T };
    } catch (err) {
      return { ok: false, error: (err as Error).message, status: 0 };
    }
  }

  /** Create a Supabase user with email/password (public signup, anon key). */
  async signUp(email: string, password: string): Promise<SupabaseResult<{ user: SupabaseUser | null; accessToken: string | null }>> {
    const res = await this.authRequest<{ user?: { id: string; email: string; created_at?: string; email_confirmed_at?: string }; access_token?: string; id?: string; email?: string }>(
      "/signup",
      { method: "POST", body: JSON.stringify({ email, password }) },
      this.opts.anonKey,
    );
    if (!res.ok) return res;
    const u = res.value.user ?? (res.value.id ? { id: res.value.id, email: res.value.email ?? email } : null);
    return {
      ok: true,
      value: {
        user: u ? { id: u.id, email: u.email ?? null, createdAt: u.created_at ?? null, emailConfirmedAt: u.email_confirmed_at ?? null } : null,
        accessToken: res.value.access_token ?? null,
      },
    };
  }

  /** Password sign-in (public, anon key). Returns the access token on success. */
  async signInWithPassword(email: string, password: string): Promise<SupabaseResult<{ accessToken: string; refreshToken: string | null; user: SupabaseUser }>> {
    const res = await this.authRequest<{ access_token?: string; refresh_token?: string; user?: { id: string; email: string; created_at?: string; email_confirmed_at?: string } }>(
      "/token?grant_type=password",
      { method: "POST", body: JSON.stringify({ email, password }) },
      this.opts.anonKey,
    );
    if (!res.ok) return res;
    if (!res.value.access_token || !res.value.user) {
      return { ok: false, error: "Supabase sign-in returned no session", status: 200 };
    }
    const u = res.value.user;
    return {
      ok: true,
      value: {
        accessToken: res.value.access_token,
        refreshToken: res.value.refresh_token ?? null,
        user: { id: u.id, email: u.email ?? null, createdAt: u.created_at ?? null, emailConfirmedAt: u.email_confirmed_at ?? null },
      },
    };
  }

  // --- Admin (server-only, service-role key) -----------------------------------

  /** List Auth users. Requires the service-role key; used for the integration report. */
  async adminListUsers(perPage = 50): Promise<SupabaseResult<SupabaseUser[]>> {
    const res = await this.authRequest<{ users?: Array<{ id: string; email: string; created_at?: string; email_confirmed_at?: string }> }>(
      `/admin/users?per_page=${perPage}`,
      { method: "GET" },
      this.opts.serviceRoleKey,
    );
    if (!res.ok) return res;
    return {
      ok: true,
      value: (res.value.users ?? []).map((u) => ({ id: u.id, email: u.email ?? null, createdAt: u.created_at ?? null, emailConfirmedAt: u.email_confirmed_at ?? null })),
    };
  }

  /** Call a PostgREST table with the service-role key. Server-side only. */
  async restSelect<T = unknown>(table: string, query = "select=*"): Promise<SupabaseResult<T[]>> {
    if (!this.opts.serviceRoleKey) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not configured", status: 0 };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/rest/v1/${table}?${query}`, {
        headers: { apikey: this.opts.serviceRoleKey, Authorization: `Bearer ${this.opts.serviceRoleKey}` },
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = JSON.parse(text) as { message?: string };
          if (body.message) detail = body.message;
        } catch {
          /* keep the generic detail */
        }
        return { ok: false, error: detail, status: res.status };
      }
      return { ok: true, value: (text ? JSON.parse(text) : []) as T[] };
    } catch (err) {
      return { ok: false, error: (err as Error).message, status: 0 };
    }
  }
}
