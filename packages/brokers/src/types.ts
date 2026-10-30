import type { BrokerAccount, Candle, Instrument, OrderStatus, Quote, TradeIntent } from "@phirst/core";

/**
 * A capability report describes only what the provider's API genuinely supports.
 * `minExpirySec` is the smallest expiry the provider accepts; a null means fixed-expiry
 * contracts are not offered at all. Never claim support that has not been verified.
 */
export interface BrokerCapabilities {
  marketData: boolean;
  marketOrders: boolean;
  fixedExpiry: boolean;
  minExpirySec: number | null;
  supportsFiveSecond: boolean;
  positions: boolean;
  orderCancel: boolean;
  streaming: boolean;
  demoAccounts: boolean;
  liveAccounts: boolean;
  /** Human-readable notes about limits, e.g. rate limits or instrument coverage. */
  notes: string[];
}

export interface ExecutionResult {
  brokerOrderId: string | null;
  status: OrderStatus;
  fillPrice: number | null;
  payout: number | null;
  /** Raw provider payload, retained for audit. Never contains credentials. */
  raw: unknown;
}

export interface BrokerPosition {
  brokerPositionId: string;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
}

export interface ConnectionCheck {
  ok: boolean;
  message: string;
  accounts: BrokerAccount[];
  /** Distinguishes "credentials rejected" from "feature not enabled on this account". */
  authenticated: boolean;
}

export interface BrokerCredentials {
  token?: string;
  appId?: string;
  apiKey?: string;
  apiSecret?: string;
  accountId?: string;
  [k: string]: string | undefined;
}

export interface BrokerAdapter {
  readonly provider: string;
  readonly displayName: string;
  capabilities(): BrokerCapabilities;
  verifyConnection(): Promise<ConnectionCheck>;
  listAccounts(): Promise<BrokerAccount[]>;
  listInstruments(): Promise<Instrument[]>;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]>;
  placeOrder(intent: TradeIntent): Promise<ExecutionResult>;
  getOrder(brokerOrderId: string): Promise<{ status: OrderStatus; profit: number | null; fillPrice: number | null; payout: number | null } | null>;
  getPositions(): Promise<BrokerPosition[]>;
  getBalance(accountId: string): Promise<number | null>;
  cancelOrder?(brokerOrderId: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "unsupported" | "rate_limit" | "network" | "rejected" | "unknown",
    readonly retriable = false,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
