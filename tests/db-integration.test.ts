import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Integration tests against a real PostgreSQL instance. They are skipped unless
 * TEST_DATABASE_URL is set, which is the honest "no database in this environment"
 * skip rather than a silent pass.
 */
const dsn = process.env.TEST_DATABASE_URL;
const maybe = dsn ? describe : describe.skip;

maybe("database integration", () => {
  let core: typeof import("@phirst/core");

  beforeAll(async () => {
    process.env.DATABASE_URL = dsn;
    core = await import("@phirst/core");
    await core.getPool().query("SELECT 1");
  });

  afterAll(async () => {
    await core.closePool().catch(() => {});
  });

  it("only one caller can hold the engine leader lock", async () => {
    const TEST_KEY = 0x7e57c0de;
    const a = await core.acquireLeaderLock(TEST_KEY);
    expect(a).not.toBeNull();
    const b = await core.acquireLeaderLock(TEST_KEY);
    expect(b).toBeNull();
    await core.releaseLeaderLock(a!);
    const c = await core.acquireLeaderLock(TEST_KEY);
    expect(c).not.toBeNull();
    await core.releaseLeaderLock(c!);
  });

  it("reports lock ownership accurately", async () => {
    const TEST_KEY = 0x7e57c0de;
    expect(core.holdsLeaderLock(null)).toBe(false);
    const t = await core.acquireLeaderLock(TEST_KEY);
    expect(core.holdsLeaderLock(t)).toBe(true);
    await core.releaseLeaderLock(t!);
    expect(core.holdsLeaderLock(t)).toBe(false);
  });

  it("persists an order and reads it back with a real broker order id", async () => {
    const id = await core.insertOrder({
      brokerId: "test-broker",
      accountId: "paper:default",
      symbol: "R_100",
      side: "buy",
      orderType: "fixed_expiry",
      amount: 10,
      durationSec: 5,
      mode: "paper",
      strategyId: null,
      origin: "test",
      clientRef: `test-${Date.now()}`,
    });
    await core.updateOrder(id, { brokerOrderId: "paper-test-1", status: "open" });
    const row = await core.getOrder(id);
    expect(row?.brokerOrderId).toBe("paper-test-1");
    expect(row?.status).toBe("open");
    expect(row?.amount).toBe(10);
    await core.updateOrder(id, { status: "settled", profit: -10, payout: 0, settledAt: new Date().toISOString() });
    const settled = await core.getOrder(id);
    expect(settled?.status).toBe("settled");
    expect(settled?.profit).toBe(-10);
    const open = await core.listOpenOrders("paper");
    expect(open.find((o) => o.id === id)).toBeUndefined();
  });
});

/**
 * Paper simulator durability. The simulator holds balance and open contracts in memory,
 * so it must be rebuilt from the database on restart. Without this a restart resets the
 * balance and orphans open contracts, which can then never settle.
 */
maybe("paper simulator restore", () => {
  let core: typeof import("@phirst/core");
  let brokers: typeof import("@phirst/brokers");
  const START = 10_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = dsn;
    core = await import("@phirst/core");
    brokers = await import("@phirst/brokers");
  });

  afterAll(async () => {
    await core.closePool().catch(() => {});
  });

  it("rebuilds balance and open contracts from settled and open orders", async () => {
    const broker = await core.createBroker({
      provider: "paper",
      label: "Restore test broker",
      credentialsEnc: new core.Vault(core.loadConfig().masterKey).encrypt("{}"),
      fingerprint: `restore-${Date.now()}`,
      capabilities: {},
    });
    const accountId = "paper:restore";
    await core.upsertAccount(broker.id, { id: accountId, type: "demo", currency: "USD", balance: START });

    // One settled winner (+50) and one settled loser (-20) => realized +30.
    for (const [profit, status] of [[50, "settled"], [-20, "settled"]] as const) {
      const id = await core.insertOrder({
        brokerId: broker.id, accountId, symbol: "R_100", side: "buy", orderType: "fixed_expiry",
        amount: 10, durationSec: 60, mode: "paper", strategyId: null, origin: "manual",
        clientRef: `restore-settled-${profit}-${Date.now()}`,
      });
      await core.updateOrder(id, { status, profit, settledAt: new Date().toISOString() });
    }
    // One open contract with 25 still at stake.
    await core.insertOrder({
      brokerId: broker.id, accountId, symbol: "R_100", side: "buy", orderType: "fixed_expiry",
      amount: 25, durationSec: 60, mode: "paper", strategyId: null, origin: "manual",
      clientRef: `restore-open-${Date.now()}`,
    });
    const openRow = await core.getPool().query(
      "SELECT id FROM orders WHERE broker_id=$1 AND account_id=$2 AND status='pending' LIMIT 1",
      [broker.id, accountId],
    );
    await core.updateOrder(String(openRow.rows[0].id), { status: "open", brokerOrderId: "paper-open-1", fillPrice: 100 });

    const restore = await core.paperRestoreState(broker.id, accountId, "paper");
    expect(restore.realizedPnl).toBe(30);
    expect(restore.openPositions).toHaveLength(1);
    expect(restore.openPositions[0].amount).toBe(25);

    // The adapter rebuilt from this state must deduct the stake still tied up.
    const adapter = brokers.createAdapter({
      provider: "paper",
      credentials: {},
      paperStartingBalance: START,
      paperRestore: restore,
    });
    const balance = await adapter.getBalance(accountId);
    expect(balance).toBe(START + 30 - 25);

    const positions = await adapter.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].brokerPositionId).toBe("paper-open-1");
  });
});
