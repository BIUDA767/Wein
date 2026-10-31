import {
  loadConfig,
  Logger,
  Vault,
  getPool,
  closePool,
  findSession,
  hashSessionToken,
  purgeExpiredSessions,
  getActiveBroker,
  listBrokers,
  getSetting,
  getUserRole,
  getUserProfile,
  setNotificationSink,
  type TradingMode,
} from "@phirst/core";
import { GeminiClient } from "@phirst/ai";
import { TradingEngine } from "@phirst/engine";
import { Router, json, error } from "./http.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerBrokerRoutes } from "./routes/brokers.ts";
import { registerEngineRoutes } from "./routes/engine.ts";
import { registerMarketRoutes } from "./routes/market.ts";
import { registerPhirstRoutes } from "./routes/phirst.ts";
import { registerTelegramRoutes } from "./routes/telegram.ts";
import { registerPreferencesRoutes } from "./routes/preferences.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerCommunityRoutes } from "./routes/community.ts";
import { registerProfileRoutes } from "./routes/profile.ts";
import { TelegramBot } from "./lib/telegram.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = new Logger(config.logLevel, { service: "api" });
  const vault = new Vault(config.masterKey);

  // Fail fast if the database is unreachable, rather than serving broken endpoints.
  const pool = getPool();
  await pool.query("SELECT 1");
  log.info("database reachable");

  const gemini = new GeminiClient({
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    fallbackModels: config.geminiFallbackModels,
    log: (m, f) => log.debug(m, f),
  });

  const activeSymbol = (await getSetting<string>("activeSymbol")) ?? "R_100";
  const autoTrade = (await getSetting<boolean>("autoTrade")) ?? false;
  const savedTradingMode = await getSetting<TradingMode>("tradingMode");
  const tradingMode: TradingMode =
    savedTradingMode === "manual" || savedTradingMode === "approval" || savedTradingMode === "autonomous"
      ? savedTradingMode
      : "manual";

  const engine = new TradingEngine({
    vault,
    log: log.child({ service: "engine" }),
    paperStartingBalance: config.paperStartingBalance,
    gemini,
    tickMs: config.engineTickMs,
    tickSeconds: 60,
    symbol: activeSymbol,
    granularitySec: 60,
    candleCount: 300,
    autoTrade,
    tradingMode,
  });
  await engine.init();

  const router = new Router(log);
  router.authenticate = async (token: string) => {
    const session = await findSession(hashSessionToken(token));
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) return null;
    const role = (await getUserRole(session.user_id)) ?? "member";
    // A suspended member is treated as unauthenticated everywhere.
    const profile = await getUserProfile(session.user_id);
    if (profile?.suspendedAt) return null;
    return { userId: session.user_id, role };
  };

  const onBrokersChanged = async () => {
    log.info("brokers changed; reloading engine adapters");
    await engine.init();
  };

  registerAuthRoutes(router, config, log);
  registerBrokerRoutes(router, config, log, vault, onBrokersChanged);
  registerEngineRoutes(router, engine, config, log);
  registerMarketRoutes(router, engine);
  registerPhirstRoutes(router, engine, gemini, config);

  const telegram = new TelegramBot(config, engine, log.child({ service: "telegram" }), async (updateId: number) => {
    try {
      const res = await pool.query("INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT (update_id) DO NOTHING", [updateId]);
      return (res.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  });
  registerPreferencesRoutes(router);
  registerAdminRoutes(router, config, log);
  registerCommunityRoutes(router, log);
  registerProfileRoutes(router, log);
  registerTelegramRoutes(router, telegram, log);
  await telegram.start();
  // Every engine notification also reaches Telegram. Fire-and-forget: delivery must never
  // add latency to the trading loop, and the notification is already persisted.
  setNotificationSink((n) => {
    telegram.notifyChannel(n).catch(() => {});
  });

  // Health and diagnostics. Public so a supervisor can probe without a session.
  router.get("/api/health", ({ res }: { res: import("node:http").ServerResponse }) => {
    void (async () => {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      try {
        await pool.query("SELECT 1");
        checks.database = { ok: true };
      } catch (err) {
        checks.database = { ok: false, detail: (err as Error).message };
      }
      const status = engine.getStatus();
      checks.broker = { ok: status.brokerConnected, detail: status.brokerError ?? undefined };
      checks.engine = { ok: status.state !== "emergency", detail: status.state };
      checks.llm = { ok: gemini.available, detail: gemini.available ? config.geminiModel : "GEMINI_API_KEY not set" };
      checks.telegram = { ok: telegram.configured, detail: telegram.configured ? "configured" : "TELEGRAM_BOT_TOKEN not set" };
      const ok = checks.database!.ok;
      json(res, ok ? 200 : 503, { ok, checks, at: new Date().toISOString() });
    })();
  }, false);

  router.get("/api/diagnostics", ({ res }: { res: import("node:http").ServerResponse }) => {
    void (async () => {
      const brokers = await listBrokers();
      const active = await getActiveBroker();
      json(res, 200, {
        engine: await engine.snapshot(),
        brokers: brokers.map((b) => ({ id: b.id, provider: b.provider, label: b.label, status: b.status, isActive: b.id === active?.id, capabilities: b.capabilities, lastError: b.last_error })),
        telegram: telegram.status(),
        llm: { available: gemini.available, model: config.geminiModel },
        env: config.env,
      });
    })();
  });

  router.setNotFound(({ res }) => {
    error(res, 404, "Not found");
  });

  const port = config.apiPort;
  await router.listen(port);

  // Periodic housekeeping: purge expired sessions every 15 minutes.
  const housekeeping = setInterval(() => {
    void purgeExpiredSessions().catch(() => {});
  }, 15 * 60 * 1000);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    clearInterval(housekeeping);
    telegram.stop();
    await engine.shutdown();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("WEIN API ready", {
    port,
    env: config.env,
    gemini: gemini.available,
    telegram: telegram.configured,
    activeSymbol,
  });
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ level: "error", msg: "api failed to start", error: (err as Error).message, stack: (err as Error).stack }) + "\n");
  process.exit(1);
});
