import type { Candle } from "./types.ts";

/** Technical indicators. Pure functions over candle arrays; no I/O, fully unit-testable. */

export function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) prev = values[i]! * k + prev * (1 - k);
  return prev;
}

/** Full EMA series so MACD can be computed without re-seeding. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult | null {
  if (values.length < slow + signalPeriod) return null;
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const offset = fastSeries.length - slowSeries.length;
  const macdSeries = slowSeries.map((s, i) => fastSeries[i + offset]! - s);
  const signalSeries = emaSeries(macdSeries, signalPeriod);
  const macdVal = macdSeries[macdSeries.length - 1]!;
  const signalVal = signalSeries[signalSeries.length - 1]!;
  return { macd: macdVal, signal: signalVal, histogram: macdVal - signalVal };
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number;
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerResult | null {
  const middle = sma(values, period);
  if (middle === null) return null;
  const slice = values.slice(-period);
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const last = values[values.length - 1]!;
  return {
    upper,
    middle,
    lower,
    bandwidth: middle === 0 ? 0 : (upper - lower) / middle,
    percentB: upper === lower ? 0.5 : (last - lower) / (upper - lower),
  };
}

export interface StochResult {
  k: number;
  d: number;
}

export function stochastic(candles: Candle[], period = 14, smoothD = 3): StochResult | null {
  if (candles.length < period + smoothD) return null;
  const ks: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map((c) => c.high));
    const low = Math.min(...window.map((c) => c.low));
    const close = candles[i]!.close;
    ks.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }
  const k = ks[ks.length - 1]!;
  const dSlice = ks.slice(-smoothD);
  const d = dSlice.reduce((a, b) => a + b, 0) / dSlice.length;
  return { k, d };
}

/** Annualised volatility from log returns; robust to scale differences. */
export function realizedVolatility(values: number[], periodsPerYear = 525600): number | null {
  if (values.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1]! <= 0) continue;
    returns.push(Math.log(values[i]! / values[i - 1]!));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** Simple slope of a linear fit over the last `period` points, normalised by mean. */
export function trendSlope(values: number[], period = 20): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const n = slice.length;
  const xMean = (n - 1) / 2;
  const yMean = slice.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (slice[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  if (den === 0 || yMean === 0) return null;
  return num / den / yMean;
}

export interface IndicatorSnapshot {
  price: number;
  smaFast: number | null;
  smaSlow: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  macd: MacdResult | null;
  atr: number | null;
  bollinger: BollingerResult | null;
  stochastic: StochResult | null;
  volatility: number | null;
  trend: number | null;
}

export function snapshot(candles: Candle[], params: { fast?: number; slow?: number; rsiPeriod?: number; atrPeriod?: number } = {}): IndicatorSnapshot {
  const fast = params.fast ?? 9;
  const slow = params.slow ?? 21;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1] ?? 0;
  return {
    price,
    smaFast: sma(closes, fast),
    smaSlow: sma(closes, slow),
    emaFast: ema(closes, fast),
    emaSlow: ema(closes, slow),
    rsi: rsi(closes, params.rsiPeriod ?? 14),
    macd: macd(closes),
    atr: atr(candles, params.atrPeriod ?? 14),
    bollinger: bollinger(closes),
    stochastic: stochastic(candles),
    volatility: realizedVolatility(closes.slice(-120)),
    trend: trendSlope(closes, slow),
  };
}
