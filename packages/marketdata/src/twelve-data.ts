/**
 * Twelve Data market-data provider.
 *
 * Twelve Data serves quotes, historical candles and reference data over REST. It does not
 * execute trades, and its `/quote` endpoint publishes a single last/close price rather than
 * a bid and an ask, so this provider reports bid == ask == mid and never invents a spread.
 *
 * Two provider limits shape this class and are enforced here rather than hoped for:
 *   1. A per-minute request limit. The account plan is read from `/api_usage`; the provider
 *      is throttled to it so a burst cannot be rejected.
 *   2. A per-day request budget. When the budget is spent, reads fail with a clear message
 *      instead of silently returning stale data as if it were live.
 *
 * Responses are cached with an explicit age. Twelve Data's plan is rate-limited and the
 * data itself is delayed, so a cache hit is served with its true timestamp and the UI is
 * responsible for labelling age; nothing here claims a cached value is real-time.
 */
import type { Candle, Instrument, Quote } from "@phirst/core";
import type { Logger } from "@phirst/core";
import type { MarketDataProvider, ProviderStatus } from "./types.ts";
import { ProviderBackpressureError } from "./types.ts";

const BASE = "https://api.twelvedata.com";

/** Interval strings Twelve Data accepts, mapped from the seconds the app uses. */
const INTERVALS: Record<number, string> = {
  60: "1min",
  120: "2min",
  180: "3min",
  300: "5min",
  600: "10min",
  900: "15min",
  1800: "30min",
  3600: "1h",
  7200: "2h",
  14400: "4h",
  28800: "8h",
  86400: "1day",
};

export interface TwelveDataOptions {
  apiKey: string;
  log: Logger;
  /** Requests allowed per minute. Discovered from the plan on first use; conservative default. */
  requestsPerMinute?: number;
  /** Requests allowed per day. Discovered from the plan; conservative default. */
  requestsPerDay?: number;
  /** How long a quote is considered usable, in ms. */
  quoteTtlMs?: number;
  /** How long a candle series is considered usable, in ms. */
  candleTtlMs?: number;
  /** How long the instrument list is cached, in ms. */
  instrumentsTtlMs?: number;
}

interface TwelveError {
  code: number;
  message: string;
  status: "error";
}

/** Twelve Data returns HTTP 200 with a body carrying `status: "error"` for many failures. */
function isError(body: unknown): body is TwelveError {
  return Boolean(body) && typeof body === "object" && (body as { status?: string }).status === "error";
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelve_data" as const;
  readonly displayName = "Twelve Data";

  private readonly quoteTtlMs: number;
  private readonly candleTtlMs: number;
  private readonly instrumentsTtlMs: number;

  private quoteCache = new Map<string, { at: number; quote: Quote }>();
  private candleCache = new Map<string, { at: number; candles: Candle[] }>();
  private instrumentsCache: { at: number; list: Instrument[] } | null = null;

  private planLimitPerMinute: number | null;
  private planLimitPerDay: number | null;
  private planCategory: string | null = null;
  private usedToday = 0;
  private usageDay: string;
  /** Timestamps of recent requests, for the per-minute window. */
  private minuteWindow: number[] = [];
  /** Set when the provider reports the daily budget is exhausted, until the UTC day rolls. */
  private dailyExhausted = false;

  constructor(private readonly opts: TwelveDataOptions) {
    this.quoteTtlMs = opts.quoteTtlMs ?? 60_000;
    this.candleTtlMs = opts.candleTtlMs ?? 120_000;
    this.instrumentsTtlMs = opts.instrumentsTtlMs ?? 24 * 60 * 60 * 1000;
    // Conservative starting limits until the real plan is read. The basic plan is 8/min;
    // starting lower than reality is safe, starting higher is not.
    this.planLimitPerMinute = opts.requestsPerMinute ?? 8;
    this.planLimitPerDay = opts.requestsPerDay ?? 800;
    this.usageDay = new Date().toISOString().slice(0, 10);
  }

  get available(): boolean {
    return Boolean(this.opts.apiKey);
  }

  status(): ProviderStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      configured: this.available,
      plan: this.planCategory,
      rateLimitPerMinute: this.planLimitPerMinute,
      dailyLimit: this.planLimitPerDay,
      requestsUsedToday: this.usedToday,
      notes: [
        "Quotes publish a single last price; bid and ask are reported equal and no spread is invented.",
        "Historical candles and quotes are cached and carry their true provider timestamp.",
        "Order execution is not provided by Twelve Data; it is separate from market data.",
      ],
    };
  }

  /** Roll the day counters when the UTC date changes. */
  private rollDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.usageDay) {
      this.usageDay = today;
      this.usedToday = 0;
      this.dailyExhausted = false;
    }
  }

  /**
   * Wait until a request is permitted under both limits, then record it. This is the one
   * place that talks to the provider, so throttling cannot be bypassed by a new endpoint.
   */
  private async acquireSlot(): Promise<void> {
    this.rollDay();
    if (this.dailyExhausted) {
      throw new ProviderBackpressureError(
        `Twelve Data daily request budget (${this.planLimitPerDay}) is exhausted. Market data resumes after 00:00 UTC.`,
      );
    }
    const limit = this.planLimitPerMinute ?? 8;
    // Drop requests older than the 60-second window.
    const cutoff = Date.now() - 60_000;
    this.minuteWindow = this.minuteWindow.filter((t) => t > cutoff);
    if (this.minuteWindow.length >= limit) {
      const waitMs = this.minuteWindow[0]! + 60_000 - Date.now() + 50;
      if (waitMs > 0) {
        this.opts.log.debug("twelve data throttle: waiting for the minute window", { waitMs, limit });
        await new Promise((r) => setTimeout(r, waitMs));
        this.minuteWindow = this.minuteWindow.filter((t) => t > Date.now() - 60_000);
      }
    }
    this.minuteWindow.push(Date.now());
    this.usedToday++;
    if (this.planLimitPerDay !== null && this.usedToday >= this.planLimitPerDay) {
      this.dailyExhausted = true;
    }
  }

  private async request<T>(path: string, params: Record<string, string | number>): Promise<T> {
    if (!this.available) throw new Error("TWELVE_DATA_API_KEY is not configured");
    await this.acquireSlot();
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        // The key travels in a header so it never appears in a URL, a log line or an error.
        headers: { Authorization: `apikey ${this.opts.apiKey}` },
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Twelve Data returned a non-JSON response (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        throw new ProviderBackpressureError("Twelve Data rate limit reached (HTTP 429). Backing off.");
      }
      if (isError(body)) {
        // A 404 in the body is a bad symbol, not a provider fault; keep the provider's wording.
        throw new Error(`Twelve Data: ${body.message}`);
      }
      if (!res.ok) {
        throw new Error(`Twelve Data HTTP ${res.status}`);
      }
      return body as T;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new Error("Twelve Data request timed out after 20000ms");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the plan once, so throttling uses the account's real ceilings rather than a guess.
   * Failure is non-fatal: the conservative defaults stand and are reported as such.
   */
  async refreshPlan(): Promise<void> {
    try {
      const usage = await this.request<{ plan_category?: string; plan_limit?: number; plan_daily_limit?: number; daily_usage?: number }>(
        "/api_usage",
        {},
      );
      if (typeof usage.plan_limit === "number" && usage.plan_limit > 0) this.planLimitPerMinute = usage.plan_limit;
      if (typeof usage.plan_daily_limit === "number" && usage.plan_daily_limit > 0) this.planLimitPerDay = usage.plan_daily_limit;
      if (typeof usage.plan_category === "string") this.planCategory = usage.plan_category;
      if (typeof usage.daily_usage === "number") this.usedToday = Math.max(this.usedToday, usage.daily_usage);
      this.opts.log.info("twelve data plan", {
        plan: this.planCategory,
        perMinute: this.planLimitPerMinute,
        perDay: this.planLimitPerDay,
      });
    } catch (err) {
      this.opts.log.warn("twelve data plan lookup failed; using conservative limits", { error: (err as Error).message });
    }
  }

  private intervalFor(granularitySec: number): string {
    const interval = INTERVALS[granularitySec];
    if (!interval) {
      throw new Error(`Twelve Data does not support a ${granularitySec}-second interval. Supported: ${Object.keys(INTERVALS).join(", ")}.`);
    }
    return interval;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const cached = this.quoteCache.get(symbol);
    if (cached && Date.now() - cached.at < this.quoteTtlMs) return cached.quote;
    try {
      const body = await this.request<{ close?: string; last_quote_at?: number; timestamp?: number }>("/quote", { symbol });
      const price = Number(body.close);
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Twelve Data returned no price for ${symbol}`);
      }
      // No bid/ask is published, so both sides equal the last price. A fabricated spread
      // would corrupt the spread-based risk checks downstream.
      const epochSec = Number(body.last_quote_at ?? body.timestamp ?? Math.floor(Date.now() / 1000));
      const quote: Quote = { symbol, bid: price, ask: price, mid: price, epochMs: epochSec * 1000 };
      this.quoteCache.set(symbol, { at: Date.now(), quote });
      return quote;
    } catch (err) {
      // Back-pressure means the provider is deliberately refusing traffic. Serving the
      // cached price here would present stale data as live, so the error propagates.
      if (err instanceof ProviderBackpressureError) throw err;
      // Any other failure is transient; serve a stale-but-labelled quote rather than
      // failing the whole trading loop.
      if (cached) {
        this.opts.log.warn("twelve data quote failed; serving cached value", { symbol, error: (err as Error).message });
        return cached.quote;
      }
      throw err;
    }
  }

  async getCandles(symbol: string, granularitySec: number, count: number): Promise<Candle[]> {
    const interval = this.intervalFor(granularitySec);
    const key = `${symbol}:${interval}:${count}`;
    const cached = this.candleCache.get(key);
    if (cached && Date.now() - cached.at < this.candleTtlMs) return cached.candles;
    try {
      const body = await this.request<{ values?: Array<Record<string, string>>; status?: string }>("/time_series", {
        symbol,
        interval,
        outputsize: Math.min(count, 5000),
        order: "ASC",
      });
      const values = body.values ?? [];
      if (values.length === 0) throw new Error(`Twelve Data returned no candles for ${symbol} at ${interval}`);
      const candles: Candle[] = values.map((v) => ({
        // Twelve Data timestamps are in the exchange's timezone but returned without one;
        // parse as UTC and treat the series as ordered, which is all the indicators need.
        epoch: Math.floor(new Date(`${v.datetime!.replace(" ", "T")}Z`).getTime() / 1000),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
      }));
      this.candleCache.set(key, { at: Date.now(), candles });
      return candles;
    } catch (err) {
      if (err instanceof ProviderBackpressureError) throw err;
      if (cached) {
        this.opts.log.warn("twelve data candles failed; serving cached value", { symbol, interval, error: (err as Error).message });
        return cached.candles;
      }
      throw err;
    }
  }

  /**
   * Reference data. Twelve Data splits instruments across several endpoints; only the
   * ones its plan actually serves are queried. A failure on one class does not sink the
   * others, so a partial list is returned rather than an error.
   */
  async listInstruments(): Promise<Instrument[]> {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.at < this.instrumentsTtlMs) {
      return this.instrumentsCache.list;
    }
    const out: Instrument[] = [];
    const push = (symbol: string, name: string, assetClass: Instrument["assetClass"], market: string, tradeable = true) => {
      if (!symbol) return;
      out.push({ symbol, name: name || symbol, assetClass, market, tradeable });
    };

    // Forex pairs.
    try {
      const fx = await this.request<{ data?: Array<{ symbol?: string; currency_base?: string; currency_quote?: string }> }>("/forex_pairs", {});
      for (const p of fx.data ?? []) push(String(p.symbol), `${p.currency_base ?? ""} / ${p.currency_quote ?? ""}`.trim(), "forex", "forex");
    } catch (err) {
      this.opts.log.warn("twelve data forex_pairs unavailable", { error: (err as Error).message });
    }

    // Crypto pairs. Twelve Data exposes these through the same forex-style endpoint family.
    try {
      const crypto = await this.request<{ data?: Array<{ symbol?: string; currency_base?: string; currency_quote?: string }> }>("/cryptocurrencies", {});
      for (const p of crypto.data ?? []) push(String(p.symbol), `${p.currency_base ?? ""} / ${p.currency_quote ?? ""}`.trim(), "crypto", "crypto");
    } catch (err) {
      this.opts.log.warn("twelve data cryptocurrencies unavailable", { error: (err as Error).message });
    }

    // US equities and ETFs.
    try {
      const stocks = await this.request<{ data?: Array<{ symbol?: string; name?: string; exchange?: string; type?: string }> }>("/stocks", {
        country: "United States",
      });
      for (const s of stocks.data ?? []) push(String(s.symbol), String(s.name ?? ""), "stocks", String(s.exchange ?? "stocks"));
    } catch (err) {
      this.opts.log.warn("twelve data stocks unavailable", { error: (err as Error).message });
    }

    this.instrumentsCache = { at: Date.now(), list: out };
    this.opts.log.info("twelve data instruments loaded", { count: out.length });
    return out;
  }

  /** Resolve a single symbol to its instrument record, for the market-information surface. */
  async describeInstrument(symbol: string): Promise<Instrument | null> {
    const body = await this.request<{ symbol?: string; name?: string; exchange?: string; type?: string; currency?: string }>("/quote", { symbol });
    if (!body.symbol) return null;
    const type = String(body.type ?? "").toLowerCase();
    const assetClass: Instrument["assetClass"] = /currency|forex/.test(type)
      ? "forex"
      : /crypto|digital/.test(type)
        ? "crypto"
        : /etf|equity|stock/.test(type)
          ? "stocks"
          : "indices";
    return {
      symbol: String(body.symbol),
      name: String(body.name ?? body.symbol),
      assetClass,
      market: String(body.exchange ?? ""),
      tradeable: true,
    };
  }
}
