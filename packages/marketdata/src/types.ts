/**
 * Market-data provider abstraction.
 *
 * The provider that supplies quotes and candles is deliberately separate from the broker
 * that executes orders. Twelve Data can quote a EUR/USD price, but it cannot place a
 * trade; Deriv can place a trade but only quotes the instruments it sells. Keeping the
 * two apart is what lets the UI say "market data: Twelve Data, execution: Deriv" honestly.
 */
import type { Candle, Instrument, Quote } from "@phirst/core";

export type ProviderId = "twelve_data" | "deriv";

export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** True when the provider is configured enough to answer requests. */
  readonly available: boolean;
  listInstruments(): Promise<Instrument[]>;
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]>;
  /** Human-readable status for the diagnostics/health surface. Never contains a secret. */
  status(): ProviderStatus;
}

/**
 * Raised when the provider is refusing traffic for a reason that will not fix itself
 * within the request: a spent daily budget or a tripped rate limit. Callers must not
 * fall back to cached data on this error, because doing so presents a stale price as if
 * it were current. It is deliberately distinguishable from a transient network fault,
 * where serving a cached value is the right call.
 */
export class ProviderBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBackpressureError";
  }
}

/**
 * A capability/entitlement report. It describes only what the provider's plan genuinely
 * permits, so the UI never offers a feature the account cannot use.
 */
export interface ProviderStatus {
  id: ProviderId;
  displayName: string;
  configured: boolean;
  /** Set when the provider reports the plan and its ceilings (Twelve Data does). */
  plan: string | null;
  /** Requests permitted per minute by the current plan, or null when unknown. */
  rateLimitPerMinute: number | null;
  /** Requests permitted per day by the current plan, or null when unknown. */
  dailyLimit: number | null;
  requestsUsedToday: number | null;
  /** Free-form, non-secret notes: coverage, limitations, what is required to enable. */
  notes: string[];
}
