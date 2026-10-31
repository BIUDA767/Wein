import { describe, it, expect } from "vitest";
import { pickDefaultAccount } from "@phirst/core";
import { DerivAdapter } from "@phirst/brokers";

/**
 * Account selection and OAuth request shaping.
 *
 * These cover the two behaviours that are easy to get subtly wrong: preferring a demo
 * account so a connection cannot silently arm real money, and omitting the Deriv-App-ID
 * header for OAuth tokens (which would otherwise make an otherwise valid connection fail).
 */

const acct = (id: string, type: "demo" | "real") => ({ id, account_id: id, account_type: type });

describe("pickDefaultAccount", () => {
  it("returns null for an empty list", () => {
    expect(pickDefaultAccount([])).toBeNull();
  });

  it("prefers a demo account even when a real account is listed first", () => {
    const chosen = pickDefaultAccount([acct("REAL1", "real"), acct("DEMO1", "demo")]);
    expect(chosen?.account_id).toBe("DEMO1");
  });

  it("falls back to the first real account when no demo exists", () => {
    const chosen = pickDefaultAccount([acct("REAL1", "real"), acct("REAL2", "real")]);
    expect(chosen?.account_id).toBe("REAL1");
  });

  it("returns the only account when there is exactly one", () => {
    expect(pickDefaultAccount([acct("SOLO", "real")])?.account_id).toBe("SOLO");
  });
});

describe("DerivAdapter auth headers", () => {
  function captureFetch(): { get: () => { url: string; headers: Record<string, string> } } {
    let captured = { url: "", headers: {} as Record<string, string> };
    const fake = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fake;
    (captureFetch as unknown as { restore: () => void }).restore = () => {
      globalThis.fetch = original;
    };
    return { get: () => captured };
  }

  it("omits the Deriv-App-ID header for an OAuth token", async () => {
    const cap = captureFetch();
    try {
      const adapter = new DerivAdapter({ token: "ory_at_x", authMethod: "oauth" });
      await adapter.listAccounts();
      expect(cap.get().headers["Authorization"]).toBe("Bearer ory_at_x");
      expect(cap.get().headers["Deriv-App-ID"]).toBeUndefined();
    } finally {
      (captureFetch as unknown as { restore: () => void }).restore();
    }
  });

  it("sends the Deriv-App-ID header for a PAT token", async () => {
    const cap = captureFetch();
    try {
      const adapter = new DerivAdapter({ token: "pat_x", appId: "1089", authMethod: "pat" });
      await adapter.listAccounts();
      expect(cap.get().headers["Authorization"]).toBe("Bearer pat_x");
      expect(cap.get().headers["Deriv-App-ID"]).toBe("1089");
    } finally {
      (captureFetch as unknown as { restore: () => void }).restore();
    }
  });

  it("maps a 401 on an OAuth token to a reconnect message", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: "Unauthorized", message: "Invalid credentials" }] }), {
        status: 401,
      })) as unknown as typeof fetch;
    try {
      const adapter = new DerivAdapter({ token: "ory_at_x", authMethod: "oauth" });
      const check = await adapter.verifyConnection();
      expect(check.ok).toBe(false);
      expect(check.message).toMatch(/expired/i);
      expect(check.message).toMatch(/reconnect/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports provider account status alongside the balance", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ account_id: "DOT90004580", balance: 10000, currency: "USD", status: "active", account_type: "demo" }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const adapter = new DerivAdapter({ token: "ory_at_x", authMethod: "oauth" });
      const accounts = await adapter.listAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: "DOT90004580",
        type: "demo",
        currency: "USD",
        balance: 10000,
        status: "active",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
