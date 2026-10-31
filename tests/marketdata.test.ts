import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, type Candle } from "@phirst/core";
import { TwelveDataProvider, MarketDataService, ProviderBackpressureError, type MarketDataProvider } from "@phirst/marketdata";

/**
 * Twelve Data is rate-limited and publishes a single last price. These tests pin the two
 * behaviours that are easy to regress and expensive to get wrong: the provider must never
 * fabricate a bid/ask spread, and it must not exceed the account's request ceilings.
 */

const quiet = new Logger("error");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function quoteBody(close: number, lastQuoteAt = 1_700_000_000) {
  return { close: String(close), last_quote_at: lastQuoteAt, status: "ok" };
}

describe("TwelveDataProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports bid == ask == mid and never invents a spread", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(quoteBody(1.1191)));
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    const quote = await provider.getQuote("EUR/USD");

    expect(quote.bid).toBe(1.1191);
    expect(quote.ask).toBe(1.1191);
    expect(quote.mid).toBe(1.1191);
    expect(quote.ask - quote.bid).toBe(0);
  });

  it("converts the provider's epoch seconds to epoch milliseconds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(quoteBody(100, 1_700_000_000)));
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    const quote = await provider.getQuote("R_100");

    expect(quote.epochMs).toBe(1_700_000_000_000);
  });

  it("sends the API key in a header, never in the URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(quoteBody(1)));
    const provider = new TwelveDataProvider({ apiKey: "super-secret-key", log: quiet });

    await provider.getQuote("EUR/USD");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).not.toContain("super-secret-key");
    expect((init.headers as Record<string, string>).Authorization).toBe("apikey super-secret-key");
  });

  it("serves a cached quote within its TTL without a second request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(quoteBody(1.1191)));
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet, quoteTtlMs: 60_000 });

    await provider.getQuote("EUR/USD");
    await provider.getQuote("EUR/USD");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the provider's own error for an unknown symbol", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 404, message: "symbol not found", status: "error" }));
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    await expect(provider.getQuote("NOPE/XXX")).rejects.toThrow(/symbol not found/);
  });

  it("rejects an interval the provider does not accept instead of guessing one", async () => {
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    await expect(provider.getCandles("EUR/USD", 45, 10)).rejects.toThrow(/does not support a 45-second interval/);
  });

  it("reads the real plan ceilings from /api_usage", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ plan_category: "pro", plan_limit: 120, plan_daily_limit: 50_000, daily_usage: 42 }),
    );
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    await provider.refreshPlan();

    const status = provider.status();
    expect(status.plan).toBe("pro");
    expect(status.rateLimitPerMinute).toBe(120);
    expect(status.dailyLimit).toBe(50_000);
  });

  it("keeps conservative limits when the plan lookup fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const provider = new TwelveDataProvider({ apiKey: "test-key", log: quiet });

    await provider.refreshPlan();

    // Starting lower than the real limit is safe; starting higher is not.
    expect(provider.status().rateLimitPerMinute).toBe(8);
    expect(provider.status().dailyLimit).toBe(800);
  });

  it("stops issuing requests once the daily budget is spent, and never masks it with stale cache", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(quoteBody(1.1))));
    const provider = new TwelveDataProvider({
      apiKey: "test-key",
      log: quiet,
      requestsPerDay: 2,
      // TTL 0 leaves a stored-but-expired cache entry, so a fetch is attempted and the
      // stale value is available to fall back on — which must not happen here.
      quoteTtlMs: 0,
    });

    const first = await provider.getQuote("EUR/USD");
    expect(first.mid).toBe(1.1);
    await provider.getQuote("R_100");
    const callsBefore = fetchMock.mock.calls.length;

    await expect(provider.getQuote("EUR/USD")).rejects.toThrow(/daily request budget .* is exhausted/i);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("does not call the provider at all when no key is configured", async () => {
    const provider = new TwelveDataProvider({ apiKey: "", log: quiet });

    expect(provider.available).toBe(false);
    await expect(provider.getQuote("EUR/USD")).rejects.toThrow(/TWELVE_DATA_API_KEY is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MarketDataService back-pressure", () => {
  it("propagates back-pressure instead of serving stale candles as live", async () => {
    const stale: Candle[] = [{ epoch: 1, open: 1, high: 1, low: 1, close: 1 }];
    let calls = 0;
    const provider: MarketDataProvider = {
      id: "twelve_data",
      displayName: "Twelve Data",
      available: true,
      listInstruments: async () => [],
      getQuote: async () => ({ symbol: "EUR/USD", bid: 1, ask: 1, mid: 1, epochMs: 0 }),
      getCandles: async () => {
        calls += 1;
        if (calls === 1) return stale;
        throw new ProviderBackpressureError("Twelve Data daily request budget (2) is exhausted.");
      },
      status: () => ({
        id: "twelve_data",
        displayName: "Twelve Data",
        configured: true,
        plan: null,
        rateLimitPerMinute: null,
        dailyLimit: null,
        requestsUsedToday: null,
        notes: [],
      }),
    };
    // Zero TTL so the cached candles are treated as expired and the provider is re-asked.
    const service = new MarketDataService(provider, quiet, 0);

    expect(await service.candles("EUR/USD", 60, 100)).toEqual(stale);
    await expect(service.candles("EUR/USD", 60, 100)).rejects.toThrow(/daily request budget/);
  });
});
