import {
  insertOrder,
  updateOrder,
  listOpenOrders,
  getOrder,
  clearPositions,
  upsertPosition,
  insertNotification,
  audit,
  type Logger,
  type OrderRecord,
  type TradeIntent,
  type TradeMode,
} from "@phirst/core";
import { BrokerError, type BrokerAdapter, type BrokerPosition } from "@phirst/brokers";

export interface ExecutionDeps {
  log: Logger;
  adapter: BrokerAdapter;
  brokerId: string;
  accountId: string;
  mode: TradeMode;
}

/**
 * Place an order exactly once. The order row is written first with a client
 * reference, then the broker is called, then the row is updated.
 *
 * If the broker returns an ambiguous result (timeout, connection drop, or a
 * response without an order id) the order is marked `unknown` and reconciliation
 * resolves it later. It is never resubmitted automatically.
 */
export async function executeIntent(deps: ExecutionDeps, intent: TradeIntent): Promise<OrderRecord> {
  const clientRef = intent.clientRef ?? `phirst-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const id = await insertOrder({
    brokerId: deps.brokerId,
    accountId: deps.accountId,
    symbol: intent.symbol,
    side: intent.side,
    orderType: intent.orderType,
    amount: intent.amount,
    durationSec: intent.durationSec ?? null,
    mode: deps.mode,
    strategyId: intent.strategyId ?? null,
    origin: intent.origin,
    clientRef,
  });

  try {
    const result = await deps.adapter.placeOrder({ ...intent, clientRef });
    await updateOrder(id, {
      brokerOrderId: result.brokerOrderId,
      status: result.status,
      fillPrice: result.fillPrice,
      payout: result.payout,
      // Record the expiry the provider accepted when it differs from the request.
      ...(result.effectiveDurationSec !== undefined ? { durationSec: result.effectiveDurationSec } : {}),
    });
    deps.log.info("order placed", {
      orderId: id,
      brokerOrderId: result.brokerOrderId,
      symbol: intent.symbol,
      side: intent.side,
      amount: intent.amount,
      mode: deps.mode,
    });
    await audit({ actor: intent.origin, action: "order.placed", target: id, detail: { symbol: intent.symbol, side: intent.side, amount: intent.amount, mode: deps.mode } });
    return (await getOrder(id))!;
  } catch (err) {
    const be = err instanceof BrokerError ? err : null;
    const rejected = be?.code === "rejected" || be?.code === "unsupported" || be?.code === "auth";
    const status = rejected ? "rejected" : "unknown";
    await updateOrder(id, { status, error: (err as Error).message });
    deps.log[rejected ? "warn" : "error"]("order failed", { orderId: id, status, error: (err as Error).message, mode: deps.mode });
    await insertNotification({
      severity: rejected ? "warning" : "critical",
      title: rejected ? "Order rejected by broker" : "Order outcome unknown — reconciliation required",
      body: `${intent.side.toUpperCase()} ${intent.symbol} for ${intent.amount}: ${(err as Error).message}`,
      category: "execution",
      meta: { orderId: id, status },
    });
    return (await getOrder(id))!;
  }
}

export interface SettlementOutcome {
  orderId: string;
  brokerOrderId: string;
  profit: number;
  payout: number;
}

/**
 * Settle open orders. Paper contracts settle from the simulator; live contracts are
 * polled from the broker. A live order whose contract has vanished from the broker
 * portfolio is reconciled by `reconcile`, not silently closed here.
 */
export async function settleOpenOrders(deps: ExecutionDeps): Promise<SettlementOutcome[]> {
  const open = await listOpenOrders(deps.mode);
  if (open.length === 0) return [];
  const outcomes: SettlementOutcome[] = [];

  // Fast path: the paper adapter can settle all expired contracts in one call.
  const maybeSettler = deps.adapter as unknown as { settleExpired?: () => Promise<Array<{ id: string; profit: number; payout: number }>> };
  if (typeof maybeSettler.settleExpired === "function") {
    const settled = await maybeSettler.settleExpired();
    for (const s of settled) {
      const order = open.find((o) => o.brokerOrderId === s.id);
      if (!order) continue;
      await updateOrder(order.id, { status: "settled", profit: s.profit, payout: s.payout, settledAt: new Date().toISOString() });
      outcomes.push({ orderId: order.id, brokerOrderId: s.id, profit: s.profit, payout: s.payout });
    }
    return outcomes;
  }

  for (const order of open) {
    if (!order.brokerOrderId) continue;
    try {
      const state = await deps.adapter.getOrder(order.brokerOrderId);
      if (!state) continue;
      if (state.status === "settled" || state.status === "filled" || state.status === "expired") {
        await updateOrder(order.id, {
          status: "settled",
          profit: state.profit,
          fillPrice: state.fillPrice ?? order.fillPrice,
          payout: state.payout,
          settledAt: new Date().toISOString(),
        });
        outcomes.push({ orderId: order.id, brokerOrderId: order.brokerOrderId, profit: state.profit ?? 0, payout: state.payout ?? 0 });
      } else if (state.status !== "unknown") {
        await updateOrder(order.id, { status: state.status });
      }
    } catch (err) {
      // A failed poll is not a settlement. Leave the order open and try again next tick.
      deps.log.warn("settlement poll failed", { orderId: order.id, error: (err as Error).message });
    }
  }
  return outcomes;
}

export interface ReconcileResult {
  brokerPositions: number;
  matched: number;
  resolved: number;
  unresolved: string[];
}

/**
 * Compare the engine's view with the broker's actual positions and open orders.
 * Runs after any connectivity loss and periodically while running. It never
 * resubmits an order.
 */
export async function reconcile(deps: ExecutionDeps): Promise<ReconcileResult> {
  const open = await listOpenOrders(deps.mode);
  let brokerPositions: BrokerPosition[] = [];
  try {
    brokerPositions = await deps.adapter.getPositions();
  } catch (err) {
    deps.log.warn("reconcile: could not read broker positions", { error: (err as Error).message });
    return { brokerPositions: 0, matched: 0, resolved: 0, unresolved: open.map((o) => o.id) };
  }

  const brokerIds = new Set(brokerPositions.map((p) => p.brokerPositionId));
  let matched = 0;
  let resolved = 0;
  const unresolved: string[] = [];

  for (const order of open) {
    if (!order.brokerOrderId) {
      unresolved.push(order.id);
      continue;
    }
    if (brokerIds.has(order.brokerOrderId)) {
      matched++;
      continue;
    }
    // Not in the broker portfolio: ask the broker what happened to it.
    try {
      const state = await deps.adapter.getOrder(order.brokerOrderId);
      if (state && (state.status === "settled" || state.status === "expired" || state.status === "filled")) {
        await updateOrder(order.id, {
          status: "settled",
          profit: state.profit,
          fillPrice: state.fillPrice ?? order.fillPrice,
          payout: state.payout,
          settledAt: new Date().toISOString(),
        });
        resolved++;
      } else {
        unresolved.push(order.id);
      }
    } catch {
      unresolved.push(order.id);
    }
  }

  // Rewrite the position table from the broker's authoritative view.
  await clearPositions(deps.brokerId, deps.accountId, deps.mode);
  for (const p of brokerPositions) {
    await upsertPosition({
      brokerId: deps.brokerId,
      accountId: deps.accountId,
      symbol: p.symbol,
      side: p.side,
      size: p.size,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl,
      mode: deps.mode,
      brokerPositionId: p.brokerPositionId,
    });
  }

  if (unresolved.length > 0) {
    await insertNotification({
      severity: "warning",
      title: "Unresolved orders after reconciliation",
      body: `${unresolved.length} order(s) could not be matched to a broker position or a settled contract. No orders were resubmitted.`,
      category: "reconciliation",
      meta: { unresolved },
    });
  }

  return { brokerPositions: brokerPositions.length, matched, resolved, unresolved };
}
