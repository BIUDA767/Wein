import { getSetting, setSetting, audit } from "@phirst/core";
import { json, error, type RequestContext, type Router } from "../http.ts";

/**
 * User interface preferences.
 *
 * These are real settings with real effects: the chart reads them when it draws, the
 * shell reads them when it lays out, and the order sheet reads them for its defaults.
 * Stored in `app_settings` under a single key because this is a single-owner
 * installation, matching how `voice` is already stored.
 */

export interface UiPreferences {
  /** Defaults applied when the trade sheet opens. */
  defaultAmount: number;
  defaultDurationSec: number;
  /** Chart presentation. */
  chartStyle: "candles" | "hollow" | "line" | "area";
  chartGrid: boolean;
  chartHeight: number;
  /** Indicators shown when the app loads. */
  defaultIndicators: string[];
  /** Timeframes offered in the selector, as seconds. */
  timeframes: number[];
  /** Which dashboard tiles are visible, in order. */
  dashboardTiles: string[];
  /** Reduce non-essential motion beyond the OS setting. */
  reducedMotion: boolean;
  /** Sound identity. */
  soundEnabled: boolean;
  soundVolume: number;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  defaultAmount: 10,
  defaultDurationSec: 60,
  chartStyle: "candles",
  chartGrid: true,
  chartHeight: 320,
  defaultIndicators: ["ema", "rsi"],
  timeframes: [60, 300, 900, 3600, 14400, 86400],
  dashboardTiles: ["equity", "pnl", "open"],
  reducedMotion: false,
  soundEnabled: true,
  soundVolume: 0.5,
};

const ALLOWED_INDICATORS = ["ema", "sma", "bollinger", "rsi", "volume"];
const ALLOWED_TILES = ["equity", "pnl", "open", "balance", "drawdown", "winrate"];
const ALLOWED_TIMEFRAMES = [5, 15, 60, 300, 900, 3600, 14400, 86400];
const CHART_STYLES = ["candles", "hollow", "line", "area"];

/** Validate and normalise a preferences payload. Rejects rather than silently fixing. */
export function normalisePreferences(input: unknown, base: UiPreferences): { ok: true; value: UiPreferences } | { ok: false; message: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const merged = { ...base, ...raw };

  const amount = Number(merged.defaultAmount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "defaultAmount must be greater than 0." };

  const duration = Number(merged.defaultDurationSec);
  if (!Number.isInteger(duration) || duration <= 0) return { ok: false, message: "defaultDurationSec must be a whole number of seconds." };

  const height = Number(merged.chartHeight);
  if (!Number.isFinite(height) || height < 160 || height > 720) return { ok: false, message: "chartHeight must be between 160 and 720." };

  const style = String(merged.chartStyle);
  if (!CHART_STYLES.includes(style)) return { ok: false, message: `chartStyle must be one of ${CHART_STYLES.join(", ")}.` };

  const volume = Number(merged.soundVolume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return { ok: false, message: "soundVolume must be between 0 and 1." };

  const indicators = Array.isArray(merged.defaultIndicators)
    ? (merged.defaultIndicators as unknown[]).map(String).filter((i) => ALLOWED_INDICATORS.includes(i))
    : base.defaultIndicators;

  const tiles = Array.isArray(merged.dashboardTiles)
    ? (merged.dashboardTiles as unknown[]).map(String).filter((t) => ALLOWED_TILES.includes(t))
    : base.dashboardTiles;

  const timeframes = Array.isArray(merged.timeframes)
    ? (merged.timeframes as unknown[]).map(Number).filter((t) => ALLOWED_TIMEFRAMES.includes(t))
    : base.timeframes;
  if (timeframes.length === 0) return { ok: false, message: "At least one timeframe must be selected." };

  return {
    ok: true,
    value: {
      defaultAmount: amount,
      defaultDurationSec: duration,
      chartStyle: style as UiPreferences["chartStyle"],
      chartGrid: Boolean(merged.chartGrid),
      chartHeight: height,
      defaultIndicators: indicators,
      timeframes,
      dashboardTiles: tiles.length ? tiles : base.dashboardTiles,
      reducedMotion: Boolean(merged.reducedMotion),
      soundEnabled: Boolean(merged.soundEnabled),
      soundVolume: volume,
    },
  };
}

export function registerPreferencesRoutes(router: Router): void {
  router.get("/api/preferences", ({ res }: RequestContext) => {
    void (async () => {
      const stored = await getSetting<Partial<UiPreferences>>("ui_preferences");
      const merged = { ...DEFAULT_UI_PREFERENCES, ...(stored ?? {}) };
      json(res, 200, { preferences: merged, defaults: DEFAULT_UI_PREFERENCES });
    })();
  });

  router.put("/api/preferences", ({ res, body, ip }: RequestContext) => {
    void (async () => {
      const stored = await getSetting<Partial<UiPreferences>>("ui_preferences");
      const base = { ...DEFAULT_UI_PREFERENCES, ...(stored ?? {}) };
      const result = normalisePreferences(body, base);
      if (!result.ok) {
        error(res, 400, result.message);
        return;
      }
      await setSetting("ui_preferences", result.value);
      await audit({ actor: "user", action: "preferences.update", detail: { ...result.value }, ip });
      json(res, 200, { ok: true, preferences: result.value });
    })();
  });
}
