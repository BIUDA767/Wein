import type { BrokerAccount, Candle, Instrument, OrderStatus, Quote, TradeIntent } from "@phirst/core";
import {
  BrokerError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerCredentials,
  type BrokerPosition,
  type ConnectionCheck,
  type ExecutionResult,
} from "../types.ts";

export interface PaperMarketData {
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]>;
  listInstruments(): Promise<Instrument[]>;
  subscribeTicks?(symbol: string, handler: (q: Quote) => void): Promise<() => void>;
}

export interface PaperPosition extends BrokerPosition {
  openedAt: number;
  expiryAt: number | null;
  contractType: "CALL" | "PUT";
  stake: number;
}

/**
 * Persisted state used to rebuild the simulator after a restart. The database is the
 * source of truth for paper trading: without this, a restart would reset the balance
 * and orphan every open contract, leaving orders that could never settle.
 */
export interface PaperRestore {
  /** Sum of profit across settled paper orders. */
  realizedPnl: number;
  openPositions: Array<{
    brokerOrderId: string;
    symbol: string;
    side: string;
    amount: number;
    entryPrice: number | null;
    expiryAt: number | null;
    openedAt: number;
  }>;
}

/**
 * Paper trading adapter.
 *
 * This is explicitly an internal simulator. It is NOT a broker connection and is
 * labelled as such everywhere it appears. It fills against real market data supplied
 * by `marketData`, so paper results are realistic, but no order ever reaches a
 * provider. Settlement is derived from the observed price at expiry.
 */
export class PaperAdapter implements BrokerAdapter {
  readonly provider = "paper";
  readonly displayName = "Paper Trading (internal simulator)";

  private balance: number;
  private positions = new Map<string, PaperPosition>();
  private seq = 0;
  private tradeLog: Array<Record<string, unknown>> = [];

  constructor(
    private readonly marketData: PaperMarketData,
    creds: BrokerCredentials,
    private readonly startingBalance: number,
    restore?: PaperRestore,
  ) {
    this.balance = startingBalance;
    if (restore) this.applyRestore(restore);
  }

  /**
   * Rebuild balance and open positions from persisted state. The stake is deducted while
   * a contract is open, so the live balance is the starting balance plus realized profit
   * minus the stake still tied up in open contracts.
   */
  private applyRestore(restore: PaperRestore): void {
    const openStake = restore.openPositions.reduce((a, p) => a + p.amount, 0);
    this.balance = Number((this.startingBalance + restore.realizedPnl - openStake).toFixed(2));
    for (const p of restore.openPositions) {
      this.positions.set(p.brokerOrderId, {
        brokerPositionId: p.brokerOrderId,
        symbol: p.symbol,
        side: p.side as "buy" | "sell",
        size: p.amount,
        entryPrice: p.entryPrice,
        currentPrice: p.entryPrice,
        unrealizedPnl: 0,
        openedAt: p.openedAt,
        expiryAt: p.expiryAt,
        contractType: p.side === "buy" ? "CALL" : "PUT",
        stake: p.amount,
      });
    }
  }

  capabilities(): BrokerCapabilities {
    return {
      marketData: true,
      marketOrders: true,
      fixedExpiry: true,
      minExpirySec: 5,
      supportsFiveSecond: true,
      positions: true,
      orderCancel: true,
      streaming: true,
      demoAccounts: true,
      liveAccounts: false,
      notes: [
        "Internal simulator. No orders are transmitted to any provider.",
        "Fills and settlement use live market data from the configured market-data provider.",
        "Use this to validate strategies before enabling a live broker.",
      ],
    };
  }

  async verifyConnection(): Promise<ConnectionCheck> {
    return {
      ok: true,
      authenticated: true,
      accounts: await this.listAccounts(),
      message: "Paper account ready. This is an internal simulator, not a broker.",
    };
  }

  async listAccounts(): Promise<BrokerAccount[]> {
    return [
      {
        id: "paper:default",
        type: "demo",
        currency: "USD",
        balance: this.balance,
        loginid: "PAPER",
        label: "Paper account",
      },
    ];
  }

  async getBalance(): Promise<number | null> {
    return this.balance;
  }

  async listInstruments(): Promise<Instrument[]> {
    return this.marketData.listInstruments();
  }

  async getQuote(symbol: string): Promise<Quote> {
    return this.marketData.getQuote(symbol);
  }

  async getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    return this.marketData.getCandles(symbol, granularitySec, count);
  }

  async placeOrder(intent: TradeIntent): Promise<ExecutionResult> {
    if (intent.amount <= 0) throw new BrokerError("Paper order amount must be positive", "rejected");
    if (intent.amount > this.balance) throw new BrokerError("Insufficient paper balance", "rejected");
    const quote = await this.marketData.getQuote(intent.symbol);
    const id = `paper-${++this.seq}-${Date.now()}`;
    const expiryAt = intent.durationSec ? Date.now() + intent.durationSec * 1000 : null;
    this.balance -= intent.amount;
    const pos: PaperPosition = {
      brokerPositionId: id,
      symbol: intent.symbol,
      side: intent.side,
      size: intent.amount,
      entryPrice: quote.mid,
      currentPrice: quote.mid,
      unrealizedPnl: 0,
      openedAt: Date.now(),
      expiryAt,
      contractType: intent.side === "buy" ? "CALL" : "PUT",
      stake: intent.amount,
    };
    this.positions.set(id, pos);
    this.tradeLog.push({ at: new Date().toISOString(), intent, fill: quote.mid, id });
    return { brokerOrderId: id, status: "open", fillPrice: quote.mid, payout: null, raw: { simulator: true, fill: quote.mid } };
  }

  /** Settle any expired paper contracts using the observed market price. */
  async settleExpired(): Promise<Array<{ id: string; profit: number; payout: number; entry: number; exit: number }>> {
    const results: Array<{ id: string; profit: number; payout: number; entry: number; exit: number }> = [];
    const now = Date.now();
    for (const [id, pos] of this.positions) {
      if (pos.expiryAt === null || pos.expiryAt > now) continue;
      const quote = await this.marketData.getQuote(pos.symbol);
      const exit = quote.mid;
      const entry = pos.entryPrice ?? exit;
      const won = pos.contractType === "CALL" ? exit > entry : exit < entry;
      // A fixed-odds payout of roughly 1.9x stake on a win, stake lost on a loss.
      const payout = won ? Number((pos.stake * 1.9).toFixed(2)) : 0;
      const profit = Number((payout - pos.stake).toFixed(2));
      this.balance += payout;
      this.positions.delete(id);
      results.push({ id, profit, payout, entry, exit });
      this.tradeLog.push({ at: new Date().toISOString(), settled: id, entry, exit, profit });
    }
    return results;
  }

  async getOrder(brokerOrderId: string): Promise<{ status: OrderStatus; profit: number | null; fillPrice: number | null; payout: number | null } | null> {
    const pos = this.positions.get(brokerOrderId);
    if (!pos) return null;
    const quote = await this.marketData.getQuote(pos.symbol);
    const entry = pos.entryPrice ?? quote.mid;
    const won = pos.contractType === "CALL" ? quote.mid > entry : quote.mid < entry;
    return {
      status: "open",
      profit: won ? Number((pos.stake * 0.9).toFixed(2)) : Number((-pos.stake).toFixed(2)),
      fillPrice: entry,
      payout: won ? Number((pos.stake * 1.9).toFixed(2)) : 0,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const pos of this.positions.values()) {
      let current = pos.currentPrice;
      try {
        current = (await this.marketData.getQuote(pos.symbol)).mid;
      } catch {
        /* keep last known price */
      }
      const entry = pos.entryPrice ?? current ?? 0;
      const won = pos.contractType === "CALL" ? (current ?? 0) > entry : (current ?? 0) < entry;
      out.push({ ...pos, currentPrice: current, unrealizedPnl: won ? pos.stake * 0.9 : -pos.stake });
    }
    return out;
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const pos = this.positions.get(brokerOrderId);
    if (!pos) return false;
    this.balance += pos.stake;
    this.positions.delete(brokerOrderId);
    return true;
  }

  getTradeLog(): Array<Record<string, unknown>> {
    return [...this.tradeLog];
  }

  async close(): Promise<void> {
    this.positions.clear();
  }
}
