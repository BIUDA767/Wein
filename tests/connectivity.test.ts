import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Connectivity failure injection against a real database and the real paper adapter.
 * The adapter's connection check is overridden to simulate an outage; everything else
 * (engine state machine, audit log, reconciliation) runs as production code.
 * Skipped unless TEST_DATABASE_URL is set.
 */
const dsn = process.env.TEST_DATABASE_URL;
const maybe = dsn ? describe : describe.skip;

maybe("engine connectivity handling", () => {
  let core: typeof import("@phirst/core");
  let engine: any;
  let adapter: any;
  let originalVerify: any;
  let outage = false;

  beforeAll(async () => {
    process.env.DATABASE_URL = dsn;
    core = await import("@phirst/core");
    const { GeminiClient } = await import("@phirst/ai");
    const { TradingEngine } = await import("@phirst/engine");

    await core.getPool().query("SELECT 1");
    await core.setRiskConfig({
      riskPerTrade: 0.01, dailyLossLimit: 500, maxDrawdown: 0.2, maxExposure: 2000,
      maxConcurrentTrades: 3, consecutiveLossLimit: 3, lossStreakDeRiskFactor: 0.5,
      maxTradeAmount: 50, allowedSymbols: [], allowedStrategies: [],
    });

    const config = core.loadConfig();

    // Ensure a real, active paper broker exists so this test exercises the real path
    // instead of returning early on an unconfigured broker.
    const existing = await core.getActiveBroker();
    if (!existing) {
      const vault = new core.Vault(config.masterKey);
      const broker = await core.createBroker({
        provider: "paper",
        label: "Connectivity test paper broker",
        credentialsEnc: vault.encrypt(JSON.stringify({})),
        fingerprint: "conn-test",
        capabilities: {},
      });
      await core.setActiveBroker(broker.id);
      await core.upsertAccount(broker.id, { id: "paper:default", type: "demo", currency: "USD", balance: 10_000 });
      const acct = await core.getPool().query("SELECT id FROM accounts WHERE broker_id=$1 LIMIT 1", [broker.id]);
      if (acct.rows[0]) await core.setActiveAccount(acct.rows[0].id);
    }

    engine = new TradingEngine({
      vault: new core.Vault(config.masterKey),
      log: new core.Logger("error", { service: "conn-test" }),
      paperStartingBalance: 10_000,
      gemini: new GeminiClient({ apiKey: null, model: "none" }),
      tickMs: 1000, tickSeconds: 5, symbol: "R_100", granularitySec: 60, candleCount: 300, autoTrade: false,
    });
    await engine.init();

    adapter = engine.active?.adapter;
    if (adapter) {
      originalVerify = adapter.verifyConnection.bind(adapter);
      adapter.verifyConnection = async () =>
        outage
          ? { ok: false, authenticated: false, accounts: [], message: "simulated outage" }
          : originalVerify();
    }
  });

  afterAll(async () => {
    if (adapter && originalVerify) adapter.verifyConnection = originalVerify;
    await engine?.shutdown().catch(() => {});
    await core?.closePool().catch(() => {});
  });

  it("blocks new trades and alerts when connectivity is lost, then reconciles on recovery", async () => {
    expect(adapter, "a paper adapter must be available for this test").toBeTruthy();

    // The paper adapter verifies as healthy.
    outage = false;
    engine.lastConnectivityCheck = 0;
    await engine.checkConnectivity();
    expect(engine.brokerConnected).toBe(true);

    // Simulate the broker going away.
    outage = true;
    engine.lastConnectivityCheck = 0;
    await engine.checkConnectivity();
    expect(engine.brokerConnected).toBe(false);
    expect(String(engine.brokerError)).toMatch(/simulated outage/);

    const lost = await core.getPool().query(
      "SELECT action FROM audit_log WHERE action = 'broker.disconnected' ORDER BY at DESC LIMIT 1",
    );
    expect(lost.rowCount).toBeGreaterThan(0);

    // The connection returns: state recovers and reconciliation runs.
    outage = false;
    engine.lastConnectivityCheck = 0;
    await engine.checkConnectivity();
    expect(engine.brokerConnected).toBe(true);
    expect(engine.brokerError).toBeNull();

    const back = await core.getPool().query(
      "SELECT action FROM audit_log WHERE action = 'broker.reconnected' ORDER BY at DESC LIMIT 1",
    );
    expect(back.rowCount).toBeGreaterThan(0);
  });
});
