/**
 * Integration routes: Twelve Data, Resend, Gemini and Supabase.
 *
 * Every route is owner-only. The service-role key and the Resend key are used exclusively
 * here, server-side, and are never returned in a response body.
 */
import {
  audit,
  getSetting,
  setSetting,
  linkSupabaseIdentity,
  getSupabaseIdentity,
  unlinkSupabaseIdentity,
  type Config,
} from "@phirst/core";
import type { GeminiClient } from "@phirst/ai";
import type { TradingEngine } from "@phirst/engine";
import { json, error, type RequestContext, type Router } from "../http.ts";
import type { IntegrationsService } from "../lib/integrations.ts";

export function registerIntegrationRoutes(
  router: Router,
  integrations: IntegrationsService,
  engine: TradingEngine,
  gemini: GeminiClient,
  config: Config,
): void {
  // --- Capability report ------------------------------------------------------

  router.owner.get("/api/integrations/status", ({ res }: RequestContext) => {
    void (async () => {
      json(res, 200, { integrations: await integrations.status() });
    })();
  });

  // --- Email (Resend) ---------------------------------------------------------

  router.owner.get("/api/integrations/email", ({ res }: RequestContext) => {
    void (async () => {
      const [ownerEmail, log] = await Promise.all([integrations.ownerEmail(), integrations.emailLog(25)]);
      json(res, 200, { status: { ...integrations.resend.status(), ownerEmail }, log });
    })();
  });

  router.owner.put("/api/integrations/email/owner", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { email } = (body ?? {}) as { email?: string | null };
      if (email !== null && email !== undefined) {
        const trimmed = String(email).trim();
        if (trimmed.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          error(res, 400, "That does not look like a valid email address.");
          return;
        }
        await integrations.setOwnerEmail(trimmed.length ? trimmed : null);
      } else {
        await integrations.setOwnerEmail(null);
      }
      await audit({ actor: "user", action: "integrations.email_owner", ip });
      json(res, 200, { ok: true, ownerEmail: await integrations.ownerEmail() });
    })();
  });

  router.owner.post("/api/integrations/email/test", ({ res, ip }: RequestContext) => {
    void (async () => {
      const result = await integrations.testEmail();
      await audit({ actor: "user", action: "integrations.email_test", detail: { ok: result.ok }, ip });
      // Report the provider's own outcome; never claim a send that failed.
      json(res, result.ok ? 200 : 400, result);
    })();
  });

  // --- Market data (Twelve Data) ----------------------------------------------

  router.owner.get("/api/integrations/market-data", ({ res }: RequestContext) => {
    void (async () => {
      if (!integrations.twelveData) {
        json(res, 200, {
          configured: false,
          provider: config.marketDataProvider,
          note: "TWELVE_DATA_API_KEY is not configured. Market data is served by the active broker's feed.",
        });
        return;
      }
      await integrations.twelveData.refreshPlan();
      json(res, 200, { configured: true, provider: config.marketDataProvider, status: integrations.twelveData.status() });
    })();
  });

  /** Switch which provider serves market data. Only a configured provider can be chosen. */
  router.owner.put("/api/integrations/market-data/provider", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { provider } = (body ?? {}) as { provider?: string };
      if (provider !== "deriv" && provider !== "twelve_data") {
        error(res, 400, 'provider must be "deriv" or "twelve_data".');
        return;
      }
      if (provider === "twelve_data" && !integrations.twelveData) {
        error(res, 400, "Twelve Data is not configured. Set TWELVE_DATA_API_KEY before selecting it.");
        return;
      }
      await setSetting("marketDataProvider", provider);
      await audit({ actor: "user", action: "integrations.market_data_provider", detail: { provider }, ip });
      json(res, 200, { ok: true, provider, note: "The engine applies this on its next broker refresh." });
    })();
  });

  /** Quote a symbol through the market-data provider (Twelve Data when selected). */
  router.owner.get("/api/integrations/market-data/quote", ({ res, url }: RequestContext) => {
    void (async () => {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) {
        error(res, 400, "symbol is required.");
        return;
      }
      if (!integrations.twelveData) {
        error(res, 400, "Twelve Data is not configured. Set TWELVE_DATA_API_KEY to quote symbols directly.");
        return;
      }
      try {
        const quote = await integrations.twelveData.getQuote(symbol);
        json(res, 200, { quote, provider: "twelve_data", delayed: true });
      } catch (err) {
        error(res, 400, (err as Error).message);
      }
    })();
  });

  // --- Gemini (analysis only) -------------------------------------------------

  /**
   * Ask Gemini for analysis grounded in real engine facts. The reply is labelled
   * `source: "llm"` so the UI can separate opinion from measured data. Gemini cannot
   * place a trade: no execution path is reachable from here.
   */
  router.owner.post("/api/integrations/gemini/analyze", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { question } = (body ?? {}) as { question?: string };
      if (question !== undefined && String(question).length > 2000) {
        error(res, 400, "question must be 2000 characters or fewer.");
        return;
      }
      if (!gemini.available) {
        error(res, 503, "GEMINI_API_KEY is not configured. AI analysis is unavailable.");
        return;
      }
      const facts = await engine.phirstFacts();
      const snapshot = await engine.snapshot();
      const context = [
        `Engine state: ${snapshot.state}; mode: ${snapshot.mode}; symbol: ${snapshot.symbol}.`,
        `Equity: ${snapshot.equity.toFixed(2)}; balance: ${snapshot.balance.toFixed(2)}; daily P&L: ${snapshot.dailyPnl.toFixed(2)}; drawdown: ${(snapshot.drawdown * 100).toFixed(2)}%.`,
        `Open trades: ${snapshot.openTrades}; consecutive losses: ${snapshot.consecutiveLosses}.`,
        `Broker connected: ${snapshot.brokerConnected}; active strategy: ${snapshot.activeStrategyId ?? "none"}.`,
        snapshot.lastPrice !== null ? `Last price for ${snapshot.symbol}: ${snapshot.lastPrice}.` : "No price is available yet.",
      ].join("\n");
      const prompt = [
        "You are analysing a live trading account. Use only the facts below. Do not invent numbers.",
        "Separate what is measured from what is your opinion. You cannot place trades.",
        "",
        context,
        "",
        question ? `Owner question: ${String(question)}` : "Provide a concise risk and performance summary.",
      ].join("\n");
      const result = await gemini.generate(prompt, {
        system:
          "You are PHIRST2, a disciplined private wealth manager. Be concise. Never invent prices, balances or events. You advise; you never execute.",
        temperature: 0.4,
        maxTokens: 1500,
        // A risk review benefits from a short amount of reasoning; the answer budget is
        // separate so the reasoning cannot consume the reply.
        thinkingBudget: 512,
      });
      await audit({ actor: "user", action: "integrations.gemini_analyze", detail: { ok: result.ok }, ip });
      if (!result.ok) {
        json(res, 502, { ok: false, error: result.error, model: result.model, source: "llm" });
        return;
      }
      json(res, 200, { ok: true, analysis: result.value, model: result.model, source: "llm", facts: { engineState: facts.engineState, symbol: facts.activeSymbol } });
    })();
  });

  // --- Supabase ---------------------------------------------------------------

  router.owner.get("/api/integrations/supabase", ({ res, userId }: RequestContext) => {
    void (async () => {
      const [health, identity] = await Promise.all([integrations.supabase.health(), userId ? getSupabaseIdentity(userId) : Promise.resolve(null)]);
      json(res, 200, {
        status: { ...integrations.supabase.status(), health },
        identity: identity
          ? { supabaseUserId: String(identity.supabase_user_id), email: (identity.email as string | null) ?? null, linkedAt: String(identity.linked_at) }
          : null,
      });
    })();
  });

  /** Verify a Supabase access token against the project JWKS. Never trusts it unverified. */
  router.owner.post("/api/integrations/supabase/verify-token", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { token } = (body ?? {}) as { token?: string };
      if (!token || typeof token !== "string") {
        error(res, 400, "token is required.");
        return;
      }
      const claims = await integrations.supabase.verifyToken(token);
      await audit({ actor: "user", action: "integrations.supabase_verify", detail: { valid: claims !== null }, ip });
      if (!claims) {
        json(res, 200, { valid: false });
        return;
      }
      json(res, 200, { valid: true, claims: { sub: claims.sub, email: claims.email ?? null, role: claims.role ?? null } });
    })();
  });

  /** List Supabase Auth users (service-role, server-side only). */
  router.owner.get("/api/integrations/supabase/users", ({ res }: RequestContext) => {
    void (async () => {
      const result = await integrations.supabase.adminListUsers(50);
      if (!result.ok) {
        error(res, result.status >= 400 ? result.status : 503, result.error);
        return;
      }
      json(res, 200, { users: result.value });
    })();
  });

  /**
   * Link the owner's Wein account to a Supabase identity. The Supabase user id is taken
   * from a verified token, never from an unverified request body.
   */
  router.owner.post("/api/integrations/supabase/link", ({ res, body, userId, ip }: RequestContext) => {
    void (async () => {
      const { token } = (body ?? {}) as { token?: string };
      if (!token || typeof token !== "string") {
        error(res, 400, "A Supabase access token is required to link an identity.");
        return;
      }
      const claims = await integrations.supabase.verifyToken(token);
      if (!claims) {
        error(res, 400, "That token could not be verified against the project's signing keys.");
        return;
      }
      if (!userId) {
        error(res, 401, "Authentication required.");
        return;
      }
      await linkSupabaseIdentity({ userId, supabaseUserId: claims.sub, email: (claims.email as string | undefined) ?? null });
      await audit({ actor: "user", action: "integrations.supabase_link", detail: { supabaseUserId: claims.sub }, ip });
      json(res, 200, { ok: true, supabaseUserId: claims.sub, email: claims.email ?? null });
    })();
  });

  router.owner.delete("/api/integrations/supabase/link", ({ res, userId, ip }: RequestContext) => {
    void (async () => {
      if (!userId) {
        error(res, 401, "Authentication required.");
        return;
      }
      await unlinkSupabaseIdentity(userId);
      await audit({ actor: "user", action: "integrations.supabase_unlink", ip });
      json(res, 200, { ok: true });
    })();
  });

  /**
   * Reachability probe for Supabase. Reports the Auth health, the public JWKS (which needs
   * no key and proves the URL is live) and whether the keys were rejected by the project.
   */
  router.owner.post("/api/integrations/supabase/probe", ({ res }: RequestContext) => {
    void (async () => {
      const [health, jwks] = await Promise.all([integrations.supabase.health(), integrations.supabase.jwksReachable()]);
      json(res, health.ok ? 200 : 503, { ...health, jwks });
    })();
  });
}
