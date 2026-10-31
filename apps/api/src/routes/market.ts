import type { TradingEngine } from "@phirst/engine";
import { json, error, type RequestContext, type Router } from "../http.ts";

/** Market data routes. Every value comes from the active broker's live feed. */
export function registerMarketRoutes(router: Router, engine: TradingEngine): void {
  router.get("/api/market/instruments", ({ res, url }: RequestContext) => {
    void (async () => {
      try {
        const all = await engine.instruments();
        const assetClass = url.searchParams.get("assetClass");
        const search = (url.searchParams.get("q") ?? "").toLowerCase();
        let list = all;
        if (assetClass) list = list.filter((i) => i.assetClass === assetClass);
        if (search) list = list.filter((i) => i.symbol.toLowerCase().includes(search) || i.name.toLowerCase().includes(search));
        json(res, 200, { instruments: list, total: all.length });
      } catch (err) {
        error(res, 503, `Market data unavailable: ${(err as Error).message}`);
      }
    })();
  });

  // A live quote for any symbol. Used by the market header and the watchlist so the
  // displayed price always comes from the active provider, never from a cached candle.
  router.get("/api/market/quote", ({ res, url }: RequestContext) => {
    void (async () => {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) { error(res, 400, "symbol is required."); return; }
      try {
        const quote = await engine.quote(symbol);
        json(res, 200, { quote });
      } catch (err) {
        error(res, 503, `Quote unavailable for ${symbol}: ${(err as Error).message}`);
      }
    })();
  });

  router.get("/api/market/candles", ({ res, url }: RequestContext) => {
    void (async () => {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) { error(res, 400, "symbol is required."); return; }
      const granularity = Number(url.searchParams.get("granularity") ?? 60);
      const count = Math.min(Number(url.searchParams.get("count") ?? 300) || 300, 1000);
      const allowed = [60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];
      if (!allowed.includes(granularity)) {
        error(res, 400, `granularity must be one of: ${allowed.join(", ")} (seconds).`);
        return;
      }
      try {
        const candles = await engine.candles(symbol, granularity, count);
        json(res, 200, { symbol, granularity, candles });
      } catch (err) {
        error(res, 503, `Candles unavailable for ${symbol}: ${(err as Error).message}`);
      }
    })();
  });
}
