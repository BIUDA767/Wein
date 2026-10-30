import { describe, it, expect } from "vitest";
import { sma, ema, emaSeries, rsi, macd, atr, bollinger, stochastic, realizedVolatility, trendSlope, snapshot } from "@phirst/core";
import type { Candle } from "@phirst/core";

function ramp(n: number, start = 100, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ epoch: 1_700_000_000 + i * 60, open: c, high: c + 0.5, low: c - 0.5, close: c }));
}

describe("sma", () => {
  it("averages the last N values", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
  });
  it("returns null when there is not enough data", () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(sma([1, 2, 3], 0)).toBeNull();
  });
});

describe("ema", () => {
  it("lags a rising series and sits between the SMA and the latest price", () => {
    const v = ramp(30);
    const e = ema(v, 10)!;
    // On a linear uptrend the EMA lags the SMA, which in turn lags the last price.
    expect(e).toBeLessThanOrEqual(sma(v, 10)!);
    expect(e).toBeGreaterThan(v[v.length - 10]!);
    expect(e).toBeLessThan(v[v.length - 1]!);
  });
  it("equals the SMA when the series is flat", () => {
    expect(ema(Array(20).fill(50), 10)).toBeCloseTo(50, 10);
  });
  it("produces a series one shorter than the input minus period plus one", () => {
    const series = emaSeries(ramp(20), 5);
    expect(series.length).toBe(20 - 5 + 1);
  });
});

describe("rsi", () => {
  it("is 100 for a monotonically rising series", () => {
    expect(rsi(ramp(30), 14)).toBe(100);
  });
  it("is 0 for a monotonically falling series", () => {
    expect(rsi(ramp(30, 100, -1), 14)).toBe(0);
  });
  it("is near 50 for an alternating series", () => {
    const v = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const r = rsi(v, 14)!;
    expect(r).toBeGreaterThan(20);
    expect(r).toBeLessThan(80);
  });
  it("returns null with insufficient data", () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe("macd", () => {
  it("returns null when the series is too short", () => {
    expect(macd(ramp(20))).toBeNull();
  });
  it("has a positive histogram for an accelerating uptrend", () => {
    const v = Array.from({ length: 80 }, (_, i) => 100 * Math.exp(i * 0.01));
    const m = macd(v)!;
    expect(m.histogram).toBeGreaterThan(0);
    expect(m.macd).toBeGreaterThan(m.signal);
  });
});

describe("atr", () => {
  it("computes a positive true range average", () => {
    const a = atr(candlesFromCloses(ramp(30)), 14);
    expect(a).not.toBeNull();
    expect(a!).toBeGreaterThan(0);
  });
  it("returns null with insufficient candles", () => {
    expect(atr(candlesFromCloses([1, 2, 3]), 14)).toBeNull();
  });
});

describe("bollinger", () => {
  it("returns null with insufficient data", () => {
    expect(bollinger([1, 2, 3], 20)).toBeNull();
  });
  it("keeps the last price inside the band for a bounded series", () => {
    const v = [10, 11, 12, 11, 10, 11, 12, 11, 10, 11, 12, 11, 10, 11, 12, 11, 10, 11, 12, 11];
    const b = bollinger(v, 20)!;
    expect(b.lower).toBeLessThanOrEqual(v[v.length - 1]!);
    expect(b.upper).toBeGreaterThanOrEqual(v[v.length - 1]!);
    expect(b.percentB).toBeGreaterThanOrEqual(0);
    expect(b.percentB).toBeLessThanOrEqual(1);
  });
});

describe("stochastic", () => {
  it("returns K near 100 when the close is at the window high", () => {
    const closes = ramp(30);
    const candles = candlesFromCloses(closes).map((c) => ({ ...c, high: c.close, low: c.close - 5 }));
    const s = stochastic(candles, 14, 3)!;
    expect(s.k).toBeGreaterThan(90);
  });
});

describe("realizedVolatility", () => {
  it("is zero for a flat series", () => {
    expect(realizedVolatility(Array(30).fill(100))).toBe(0);
  });
  it("is positive for a varying series", () => {
    expect(realizedVolatility(ramp(30))).toBeGreaterThan(0);
  });
  it("returns null when there are too few points", () => {
    expect(realizedVolatility([1, 2])).toBeNull();
  });
});

describe("trendSlope", () => {
  it("is positive for an uptrend and negative for a downtrend", () => {
    expect(trendSlope(ramp(30), 20)!).toBeGreaterThan(0);
    expect(trendSlope(ramp(30, 100, -1), 20)!).toBeLessThan(0);
  });
  it("is null with insufficient data", () => {
    expect(trendSlope([1, 2, 3], 20)).toBeNull();
  });
});

describe("snapshot", () => {
  it("populates every indicator for a long enough series", () => {
    const s = snapshot(candlesFromCloses(ramp(120)));
    expect(s.price).toBe(219);
    expect(s.smaFast).not.toBeNull();
    expect(s.smaSlow).not.toBeNull();
    expect(s.rsi).not.toBeNull();
    expect(s.macd).not.toBeNull();
    expect(s.atr).not.toBeNull();
    expect(s.bollinger).not.toBeNull();
    expect(s.stochastic).not.toBeNull();
    expect(s.volatility).not.toBeNull();
    expect(s.trend).not.toBeNull();
  });
});
