/**
 * Caching, rate-limit-aware facade over a market-data provider.
 *
 * This is the only object the trading loop reads market data through. It exists because
 * providers charge for historical candles and throttle aggressively: a loop that asks
 * every second would be throttled into uselessness. A fresh cache hit is served instantly,
 * a rate limit is respected rather than retried, and a failed fetch falls back to the last
 * good value rather than failing the tick.
 */
import type { Candle, Instrument, Quote } from "@phirst/core";
import type { Logger } from "@phirst/core";
import type { MarketDataProvider, ProviderId, ProviderStatus } from "./types.ts";
import { ProviderBackpressureError } from "./types.ts";

export class MarketDataService {
  private candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private instrumentsCache: { at: number; list: Instrument[] } | null = null;
  private quoteCache = new Map<string, { at: number; quote: Quote }>();
  private rateLimitedUntil = 0;

  constructor(
    private provider: MarketDataProvider,
    private log: Logger,
    private candleTtlMs = 6000,
    private instrumentsTtlMs = 300_000,
    private quoteTtlMs = 15_000,
  ) {}

  get providerId(): ProviderId {
    return this.provider.id;
  }

  status(): ProviderStatus {
    return this.provider.status();
  }

  setProvider(provider: MarketDataProvider): void {
    this.provider = provider;
    this.invalidate();
  }

  /** Candles with a cache, a rate-limit cooldown and stale-while-error behaviour. */
  async candles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    const key = `${symbol}:${granularitySec}:${count}`;
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < this.candleTtlMs) return hit.candles;
    if (Date.now() < this.rateLimitedUntil) {
      if (hit) return hit.candles;
      throw new Error(`Market data is rate limited until ${new Date(this.rateLimitedUntil).toISOString()}`);
    }
    try {
      const candles = await this.provider.getCandles(symbol, granularitySec, count);
      this.candleCache.set(key, { at: Date.now(), candles });
      return candles;
    } catch (err) {
      const message = (err as Error).message;
      // A back-pressure error is deliberate: apply a cooldown and serve a fresh cache hit
      // if one exists, but never present a stale value as if it were live.
      if (err instanceof ProviderBackpressureError || /rate limit|429/i.test(message)) {
        this.rateLimitedUntil = Date.now() + 60_000;
        this.log.warn("market data rate limited; backing off", { symbol, cooldownSec: 60 });
        if (hit && Date.now() - hit.at < this.candleTtlMs) return hit.candles;
      }
      throw err;
    }
  }

  async quote(symbol: string): Promise<Quote> {
    const hit = this.quoteCache.get(symbol);
    if (hit && Date.now() - hit.at < this.quoteTtlMs) return hit.quote;
    const quote = await this.provider.getQuote(symbol);
    this.quoteCache.set(symbol, { at: Date.now(), quote });
    return quote;
  }

  /**
   * Absolute bid/ask spread for a symbol, or null when the provider does not publish both
   * sides. Twelve Data publishes a single last price, so it reports null here and the
   * spread-based checks downstream treat it as unknown rather than assuming zero.
   */
  async spread(symbol: string): Promise<number | null> {
    try {
      const q = await this.quote(symbol);
      return q.ask > 0 && q.bid > 0 && q.ask >= q.bid && q.ask !== q.bid ? q.ask - q.bid : null;
    } catch (err) {
      this.log.debug("quote unavailable for spread", { symbol, error: (err as Error).message });
      return null;
    }
  }

  async instruments(): Promise<Instrument[]> {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.at < this.instrumentsTtlMs) {
      return this.instrumentsCache.list;
    }
    const list = await this.provider.listInstruments();
    this.instrumentsCache = { at: Date.now(), list };
    return list;
  }

  async resolveInstrument(symbol: string): Promise<Instrument | null> {
    const list = await this.instruments();
    return list.find((i) => i.symbol === symbol) ?? null;
  }

  invalidate(): void {
    this.candleCache.clear();
    this.instrumentsCache = null;
    this.quoteCache.clear();
  }

  /** The most recent candles for a series without requesting anything. */
  peek(symbol: string, granularitySec: number, count: number): Candle[] | null {
    return this.candleCache.get(`${symbol}:${granularitySec}:${count}`)?.candles ?? null;
  }
}

export interface ResolveMarketDataOptions {
  preferred: ProviderId;
  twelveData: MarketDataProvider | null;
  brokerFeed: MarketDataProvider;
  log: Logger;
}

/**
 * Choose the market-data provider. The owner's preference is honoured only when that
 * provider is actually usable; otherwise the broker feed is used and the fallback is
 * logged, so the app keeps running without a market-data subscription.
 */
export function resolveMarketDataProvider(opts: ResolveMarketDataOptions): MarketDataProvider {
  if (opts.preferred === "twelve_data") {
    if (opts.twelveData && opts.twelveData.available) return opts.twelveData;
    opts.log.warn("Twelve Data requested but not configured; using the broker feed for market data");
  }
  return opts.brokerFeed;
}
