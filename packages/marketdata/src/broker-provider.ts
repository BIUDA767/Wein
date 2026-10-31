/**
 * A market-data provider backed by the active broker's own feed.
 *
 * Deriv publishes quotes and candles over its public WebSocket without authentication, so
 * the broker's feed is a legitimate market-data source and remains the default. This
 * wrapper exists so the engine can treat "the broker's feed" and "Twelve Data" behind one
 * interface and switch between them without either side knowing about the other.
 *
 * It is typed structurally against the three methods the adapter exposes, so this package
 * does not depend on the broker package.
 */
import type { Candle, Instrument, Quote } from "@phirst/core";
import type { MarketDataProvider, ProviderStatus } from "./types.ts";

export interface BrokerFeed {
  getQuote(symbol: string): Promise<Quote>;
  getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]>;
  listInstruments(): Promise<Instrument[]>;
}

export class BrokerMarketDataProvider implements MarketDataProvider {
  readonly id = "deriv" as const;
  readonly displayName = "Broker feed (Deriv public WebSocket)";

  constructor(
    private readonly feed: BrokerFeed | null,
    private readonly brokerName: string | null = null,
  ) {}

  get available(): boolean {
    return this.feed !== null;
  }

  status(): ProviderStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      configured: this.available,
      plan: null,
      rateLimitPerMinute: null,
      dailyLimit: null,
      requestsUsedToday: null,
      notes: [
        this.brokerName
          ? `Sourced from the active broker (${this.brokerName}); requires no market-data subscription.`
          : "No active broker is configured, so no broker feed is available.",
        "Covers the instruments the broker offers; broader coverage needs a market-data provider.",
      ],
    };
  }

  private require(): BrokerFeed {
    if (!this.feed) throw new Error("No active broker feed is available for market data.");
    return this.feed;
  }

  listInstruments(): Promise<Instrument[]> {
    return this.require().listInstruments();
  }
  getQuote(symbol: string): Promise<Quote> {
    return this.require().getQuote(symbol);
  }
  getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    return this.require().getCandles(symbol, granularitySec, count);
  }
}
