import type { Candle, StrategySignal } from "../types.ts";
import type { IndicatorSnapshot } from "../indicators.ts";

export interface StrategyContext {
  symbol: string;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  params: Record<string, unknown>;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  defaultParams: Record<string, unknown>;
  evaluate(ctx: StrategyContext): StrategySignal;
}

export function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function signal(
  strategyId: string,
  symbol: string,
  direction: StrategySignal["direction"],
  confidence: number,
  reasons: string[],
  entry?: number,
  durationSec?: number,
): StrategySignal {
  return {
    strategyId,
    symbol,
    direction,
    confidence: Math.max(0, Math.min(1, confidence)),
    entry,
    durationSec,
    reasons,
    at: new Date().toISOString(),
  };
}

export const BUILTIN_STRATEGIES: Strategy[] = [
  {
    id: "trend_ema",
    name: "EMA Trend Rider",
    description: "Trades in the direction of a fast/slow EMA cross, filtered by trend slope and ATR.",
    defaultParams: { fast: 9, slow: 21, minTrend: 0.0005, durationSec: 300 },
    evaluate({ symbol, indicators, params }) {
      const { emaFast, emaSlow, trend, price } = indicators;
      if (emaFast === null || emaSlow === null || trend === null) {
        return signal("trend_ema", symbol, "flat", 0, ["Insufficient data for EMA trend."]);
      }
      const minTrend = num(params, "minTrend", 0.0005);
      const spread = (emaFast - emaSlow) / emaSlow;
      const reasons = [
        `EMA fast ${emaFast.toFixed(4)} vs slow ${emaSlow.toFixed(4)} (spread ${(spread * 100).toFixed(3)}%).`,
        `Trend slope ${(trend * 100).toFixed(4)}% per bar.`,
      ];
      if (spread > 0 && trend > minTrend) {
        return signal("trend_ema", symbol, "long", Math.min(1, spread / 0.002), reasons, price, num(params, "durationSec", 300));
      }
      if (spread < 0 && trend < -minTrend) {
        return signal("trend_ema", symbol, "short", Math.min(1, Math.abs(spread) / 0.002), reasons, price, num(params, "durationSec", 300));
      }
      return signal("trend_ema", symbol, "flat", 0.2, [...reasons, "No aligned trend."]);
    },
  },
  {
    id: "mean_reversion_bollinger",
    name: "Bollinger Mean Reversion",
    description: "Fades moves that stretch beyond the Bollinger bands, with RSI confirmation.",
    defaultParams: { period: 20, mult: 2, rsiLow: 30, rsiHigh: 70, durationSec: 180 },
    evaluate({ symbol, indicators, params }) {
      const { bollinger, rsi, price } = indicators;
      if (!bollinger || rsi === null) {
        return signal("mean_reversion_bollinger", symbol, "flat", 0, ["Insufficient data for Bollinger/RSI."]);
      }
      const rsiLow = num(params, "rsiLow", 30);
      const rsiHigh = num(params, "rsiHigh", 70);
      const reasons = [
        `PercentB ${bollinger.percentB.toFixed(3)}, bandwidth ${(bollinger.bandwidth * 100).toFixed(2)}%.`,
        `RSI ${rsi.toFixed(1)}.`,
      ];
      if (bollinger.percentB < 0.05 && rsi < rsiLow) {
        return signal("mean_reversion_bollinger", symbol, "long", Math.min(1, (rsiLow - rsi) / rsiLow + 0.4), reasons, price, num(params, "durationSec", 180));
      }
      if (bollinger.percentB > 0.95 && rsi > rsiHigh) {
        return signal("mean_reversion_bollinger", symbol, "short", Math.min(1, (rsi - rsiHigh) / (100 - rsiHigh) + 0.4), reasons, price, num(params, "durationSec", 180));
      }
      return signal("mean_reversion_bollinger", symbol, "flat", 0.2, [...reasons, "Price within bands."]);
    },
  },
  {
    id: "momentum_rsi",
    name: "RSI Momentum Reversal",
    description: "Reversal entries from RSI extremes with stochastic confirmation.",
    defaultParams: { oversold: 28, overbought: 72, durationSec: 120 },
    evaluate({ symbol, indicators, params }) {
      const { rsi, stochastic: stoch, price } = indicators;
      if (rsi === null) return signal("momentum_rsi", symbol, "flat", 0, ["Insufficient data for RSI."]);
      const oversold = num(params, "oversold", 28);
      const overbought = num(params, "overbought", 72);
      const reasons = [`RSI ${rsi.toFixed(1)}.`, stoch ? `Stochastic %K ${stoch.k.toFixed(1)} / %D ${stoch.d.toFixed(1)}.` : "Stochastic unavailable."];
      const stochOkLong = !stoch || stoch.k < 25;
      const stochOkShort = !stoch || stoch.k > 75;
      if (rsi <= oversold && stochOkLong) {
        return signal("momentum_rsi", symbol, "long", Math.min(1, (oversold - rsi) / oversold + 0.5), reasons, price, num(params, "durationSec", 120));
      }
      if (rsi >= overbought && stochOkShort) {
        return signal("momentum_rsi", symbol, "short", Math.min(1, (rsi - overbought) / (100 - overbought) + 0.5), reasons, price, num(params, "durationSec", 120));
      }
      return signal("momentum_rsi", symbol, "flat", 0.2, [...reasons, "RSI in neutral range."]);
    },
  },
  {
    id: "macd_momentum",
    name: "MACD Momentum",
    description: "Trades MACD histogram expansions in the direction of the trend slope.",
    defaultParams: { minHistogram: 0, durationSec: 300 },
    evaluate({ symbol, indicators, params }) {
      const { macd: m, trend, price } = indicators;
      if (!m || trend === null) return signal("macd_momentum", symbol, "flat", 0, ["Insufficient data for MACD."]);
      const reasons = [
        `MACD ${m.macd.toFixed(4)}, signal ${m.signal.toFixed(4)}, histogram ${m.histogram.toFixed(4)}.`,
        `Trend slope ${(trend * 100).toFixed(4)}%.`,
      ];
      const minHist = num(params, "minHistogram", 0);
      if (m.histogram > minHist && trend > 0) {
        return signal("macd_momentum", symbol, "long", Math.min(1, Math.abs(m.histogram) / (Math.abs(m.macd) + 1e-9)), reasons, price, num(params, "durationSec", 300));
      }
      if (m.histogram < -minHist && trend < 0) {
        return signal("macd_momentum", symbol, "short", Math.min(1, Math.abs(m.histogram) / (Math.abs(m.macd) + 1e-9)), reasons, price, num(params, "durationSec", 300));
      }
      return signal("macd_momentum", symbol, "flat", 0.2, [...reasons, "No MACD momentum."]);
    },
  },
  {
    id: "breakout_atr",
    name: "ATR Volatility Breakout",
    description: "Breaks out of the recent range when volatility (ATR) confirms expansion.",
    defaultParams: { lookback: 20, atrMult: 1.0, durationSec: 240 },
    evaluate({ symbol, candles, indicators, params }) {
      const { atr: atrVal, price } = indicators;
      if (atrVal === null || candles.length < num(params, "lookback", 20) + 1) {
        return signal("breakout_atr", symbol, "flat", 0, ["Insufficient data for breakout."]);
      }
      const lookback = num(params, "lookback", 20);
      const window = candles.slice(-lookback - 1, -1);
      const high = Math.max(...window.map((c) => c.high));
      const low = Math.min(...window.map((c) => c.low));
      const atrMult = num(params, "atrMult", 1);
      const reasons = [`Range high ${high.toFixed(4)}, low ${low.toFixed(4)}, ATR ${atrVal.toFixed(4)}.`];
      if (price > high + atrVal * atrMult) {
        return signal("breakout_atr", symbol, "long", Math.min(1, (price - high) / (atrVal * 4)), reasons, price, num(params, "durationSec", 240));
      }
      if (price < low - atrVal * atrMult) {
        return signal("breakout_atr", symbol, "short", Math.min(1, (low - price) / (atrVal * 4)), reasons, price, num(params, "durationSec", 240));
      }
      return signal("breakout_atr", symbol, "flat", 0.2, [...reasons, "Inside range."]);
    },
  },
];

export function getBuiltin(id: string): Strategy | undefined {
  return BUILTIN_STRATEGIES.find((s) => s.id === id);
}

/** A custom strategy is a built-in template plus parameter overrides. */
export function resolveStrategy(id: string, customParams: Record<string, unknown>): Strategy | null {
  const baseId = id.startsWith("custom:") ? id.split(":")[1]! : id;
  const base = getBuiltin(baseId);
  if (!base) return null;
  const params = { ...base.defaultParams, ...customParams };
  return {
    ...base,
    id,
    params: undefined as never,
    defaultParams: params,
    evaluate: (ctx: StrategyContext) => base.evaluate({ ...ctx, params: { ...params, ...ctx.params } }),
  } as unknown as Strategy;
}
