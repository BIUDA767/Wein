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
