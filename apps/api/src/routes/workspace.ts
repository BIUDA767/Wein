import { getSetting, setSetting, insertNotification, audit } from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";
import type { TradingEngine } from "@phirst/engine";

/**
 * Watchlist and price alerts.
 *
 * Both are real, persisted user state, not UI decoration: a watchlist is stored under
 * `app_settings` and a price alert is evaluated against the live quote from the active
 * market-data provider. An alert fires only when a real quote crosses the threshold, and
 * the crossing is recorded in `notifications` so it also reaches Telegram and the bell.
 *
 * The single-owner installation keeps one watchlist and one alert set, matching how the
 * other preferences are stored.
 */

export interface PriceAlert {
  id: string;
  symbol: string;
  /** Fire when the mid price rises to or above this level. */
  above: number | null;
  /** Fire when the mid price falls to or below this level. */
  below: number | null;
  createdAt: string;
  /** Set once the alert has fired; fired alerts are kept for the record, not re-armed. */
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

const WATCHLIST_KEY = "watchlist";
const ALERTS_KEY = "priceAlerts";

const DEFAULT_WATCHLIST = ["R_100", "R_50", "frxEURUSD", "cryBTCUSD", "frxXAUUSD"];

async function readWatchlist(): Promise<string[]> {
  const saved = await getSetting<string[]>(WATCHLIST_KEY);
  if (Array.isArray(saved) && saved.every((s) => typeof s === "string")) return saved;
  return DEFAULT_WATCHLIST;
}

async function readAlerts(): Promise<PriceAlert[]> {
  const saved = await getSetting<PriceAlert[]>(ALERTS_KEY);
  return Array.isArray(saved) ? saved : [];
}

/**
 * Evaluate every armed alert against a fresh quote and fire the ones that crossed. Called
 * by the alerts endpoint the UI polls; it is deliberately stateless apart from the store,
 * so it works whether the engine is running or stopped.
 */
async function evaluateAlerts(engine: TradingEngine): Promise<PriceAlert[]> {
  const alerts = await readAlerts();
  const armed = alerts.filter((a) => !a.triggeredAt);
  if (armed.length === 0) return alerts;
  const symbols = [...new Set(armed.map((a) => a.symbol))];
  const quotes = await engine.quotes(symbols);
  let changed = false;
  for (const alert of armed) {
    const quote = quotes[alert.symbol];
    if (!quote) continue;
    const price = quote.mid;
    const hitAbove = alert.above !== null && price >= alert.above;
    const hitBelow = alert.below !== null && price <= alert.below;
    if (!hitAbove && !hitBelow) continue;
    alert.triggeredAt = new Date().toISOString();
    alert.triggeredPrice = price;
    changed = true;
    const direction = hitAbove ? "rose to" : "fell to";
    await insertNotification({
      severity: "warning",
      title: `${alert.symbol} ${direction} ${price}`,
      body: `Your price alert for ${alert.symbol} triggered: the live mid price ${direction} your ${hitAbove ? "upper" : "lower"} threshold of ${hitAbove ? alert.above : alert.below}.`,
      category: "market",
      meta: { alertId: alert.id, symbol: alert.symbol, price },
    });
    await audit({ actor: "system", action: "alert.triggered", target: alert.id, detail: { symbol: alert.symbol, price } });
  }
  if (changed) await setSetting(ALERTS_KEY, alerts);
  return alerts;
}

export function registerWorkspaceRoutes(router: Router, engine: TradingEngine): void {
  router.owner.get("/api/watchlist", ({ res }: RequestContext) => {
    void (async () => {
      const symbols = await readWatchlist();
      json(res, 200, { symbols });
    })();
  });

  router.owner.post("/api/watchlist", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { symbol } = (body ?? {}) as { symbol?: string };
      const clean = String(symbol ?? "").trim();
      if (!clean) {
        error(res, 400, "symbol is required.");
        return;
      }
      const symbols = await readWatchlist();
      if (!symbols.includes(clean)) symbols.push(clean);
      await setSetting(WATCHLIST_KEY, symbols);
      await audit({ actor: "user", action: "watchlist.add", target: clean, ip });
      json(res, 200, { ok: true, symbols });
    })();
  });

  router.owner.delete("/api/watchlist/:symbol", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const symbol = params.symbol!;
      const symbols = (await readWatchlist()).filter((s) => s !== symbol);
      await setSetting(WATCHLIST_KEY, symbols);
      await audit({ actor: "user", action: "watchlist.remove", target: symbol, ip });
      json(res, 200, { ok: true, symbols });
    })();
  });

  // Live quotes for the watchlist, so the list shows real prices rather than symbols only.
  router.owner.get("/api/watchlist/quotes", ({ res }: RequestContext) => {
    void (async () => {
      const symbols = await readWatchlist();
      try {
        const quotes = await engine.quotes(symbols);
        json(res, 200, { quotes });
      } catch (err) {
        error(res, 503, `Market data unavailable: ${(err as Error).message}`);
      }
    })();
  });

  router.owner.get("/api/alerts", ({ res }: RequestContext) => {
    void (async () => {
      try {
        const alerts = await evaluateAlerts(engine);
        json(res, 200, { alerts });
      } catch (err) {
        error(res, 503, `Could not evaluate alerts: ${(err as Error).message}`);
      }
    })();
  });

  router.owner.post("/api/alerts", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const { symbol, above, below } = (body ?? {}) as { symbol?: string; above?: number | null; below?: number | null };
      const clean = String(symbol ?? "").trim();
      if (!clean) {
        error(res, 400, "symbol is required.");
        return;
      }
      const up = above === null || above === undefined ? null : Number(above);
      const down = below === null || below === undefined ? null : Number(below);
      if (up === null && down === null) {
        error(res, 400, "Provide an upper or lower threshold for the alert.");
        return;
      }
      if (up !== null && !Number.isFinite(up)) {
        error(res, 400, "Upper threshold must be a number.");
        return;
      }
      if (down !== null && !Number.isFinite(down)) {
        error(res, 400, "Lower threshold must be a number.");
        return;
      }
      const alerts = await readAlerts();
      const alert: PriceAlert = {
        id: `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        symbol: clean,
        above: up,
        below: down,
        createdAt: new Date().toISOString(),
        triggeredAt: null,
        triggeredPrice: null,
      };
      alerts.push(alert);
      await setSetting(ALERTS_KEY, alerts);
      await audit({ actor: "user", action: "alert.create", target: alert.id, detail: { symbol: clean, above: up, below: down }, ip });
      json(res, 200, { ok: true, alert });
    })();
  });

  router.owner.delete("/api/alerts/:id", ({ res, params, ip }: RequestContext) => {
    void (async () => {
      const id = params.id!;
      const alerts = (await readAlerts()).filter((a) => a.id !== id);
      await setSetting(ALERTS_KEY, alerts);
      await audit({ actor: "user", action: "alert.delete", target: id, ip });
      json(res, 200, { ok: true });
    })();
  });
}
