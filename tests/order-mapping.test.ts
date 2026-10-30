import { describe, it, expect } from "vitest";
import { mapOrderRow } from "@phirst/core";

/**
 * Regression guard. PostgreSQL hands back snake_case columns and numeric types as
 * strings. Reading them as a camelCase OrderRecord silently produced `undefined`
 * brokerOrderId, which made order settlement impossible to match.
 */
describe("order row mapping", () => {
  const rawRow = {
    id: "ord-1",
    broker_order_id: "paper-7-1700000000000",
    broker_id: "brk-1",
    account_id: "paper:default",
    symbol: "R_100",
    side: "buy",
    order_type: "fixed_expiry",
    amount: "25.50",
    duration_sec: 5,
    status: "open",
    fill_price: "578.79",
    payout: null,
    profit: null,
    mode: "paper",
    strategy_id: "trend_ema",
    origin: "agent",
    client_ref: "phirst-abc",
    error: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    settled_at: null,
  };

  it("exposes brokerOrderId, which settlement matching depends on", () => {
    const order = mapOrderRow(rawRow);
    expect(order.brokerOrderId).toBe("paper-7-1700000000000");
    expect(order.id).toBe("ord-1");
  });

  it("converts numeric strings to numbers", () => {
    const order = mapOrderRow(rawRow);
    expect(order.amount).toBe(25.5);
    expect(order.fillPrice).toBe(578.79);
    expect(typeof order.amount).toBe("number");
  });

  it("preserves nulls rather than coercing them to zero", () => {
    const order = mapOrderRow(rawRow);
    expect(order.profit).toBeNull();
    expect(order.payout).toBeNull();
    expect(order.settledAt).toBeNull();
  });

  it("maps a settled row with its realised result", () => {
    const order = mapOrderRow({ ...rawRow, status: "settled", profit: "-10.00", payout: "0.00", settled_at: "2026-01-01T00:00:05.000Z" });
    expect(order.status).toBe("settled");
    expect(order.profit).toBe(-10);
    expect(order.payout).toBe(0);
    expect(order.settledAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("keeps strategyId so per-strategy reporting is accurate", () => {
    expect(mapOrderRow(rawRow).strategyId).toBe("trend_ema");
    expect(mapOrderRow({ ...rawRow, strategy_id: null }).strategyId).toBeNull();
  });
});
