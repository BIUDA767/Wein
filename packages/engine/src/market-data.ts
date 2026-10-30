import type { Candle, Instrument, Quote } from "@phirst/core";
import type { Logger } from "@phirst/core";
import type { BrokerAdapter } from "@phirst/brokers";

/** Thin, cached wrapper over a broker adapter's public market data. */
export class MarketDataService {
  private candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private instrumentsCache: { at: number; list: Instrument[] } | null = null;
  /** Set when the provider rate-limits us, so we stop hammering it. */
  private rateLimitedUntil = 0;

  constructor(
    private adapter: BrokerAdapter,
    private log: Logger,
    private candleTtlMs = 6000,
    private instrumentsTtlMs = 300_000,
  ) {}

  setAdapter(adapter: BrokerAdapter): void {
    this.adapter = adapter;
    this.candleCache.clear();
    this.instrumentsCache = null;
  }

  /**
   * Candles with a cache, a rate-limit cooldown and stale-while-error behaviour.
   *
   * Providers charge for historical candles and rate-limit them aggressively. A trading
   * loop that asks every second would be throttled into uselessness, so a fresh cache
   * hit is served instantly and a rate limit is respected rather than retried.
   */
  async candles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    const key = `${symbol}:${granularitySec}:${count}`;
    const hit = this.candleCache.get(key);
    const fresh = hit && Date.now() - hit.at < this.candleTtlMs;
    if (fresh) return hit.candles;
    if (Date.now() < this.rateLimitedUntil) {
      if (hit) return hit.candles;
      throw new Error(`Market data is rate limited until ${new Date(this.rateLimitedUntil).toISOString()}`);
    }
    try {
      const candles = await this.adapter.getCandles(symbol, granularitySec, count);
      this.candleCache.set(key, { at: Date.now(), candles });
      return candles;
    } catch (err) {
      const message = (err as Error).message;
      if (/rate limit/i.test(message)) {
        this.rateLimitedUntil = Date.now() + 60_000;
        this.log.warn("market data rate limited; backing off", { symbol, cooldownSec: 60 });
        if (hit) return hit.candles;
      }
      throw err;
    }
  }

  async quote(symbol: string): Promise<Quote> {
    return this.adapter.getQuote(symbol);
  }

  async instruments(): Promise<Instrument[]> {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.at < this.instrumentsTtlMs) {
      return this.instrumentsCache.list;
    }
    const list = await this.adapter.listInstruments();
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
  }

  /** The most recent candles for a series without requesting anything. */
  peek(symbol: string, granularitySec: number, count: number): Candle[] | null {
    return this.candleCache.get(`${symbol}:${granularitySec}:${count}`)?.candles ?? null;
  }
}
