import { describe, it, expect } from "vitest";
import { resolveStrategy, snapshot, BUILTIN_STRATEGIES, type Candle } from "@phirst/core";

function candles(values: number[], stepMs = 60_000): Candle[] {
  const start = Math.floor((Date.now() - values.length * stepMs) / 1000);
  const step = Math.floor(stepMs / 1000);
  return values.map((close, i) => ({
    epoch: start + i * step,
    open: close, high: close * 1.0005, low: close * 0.9995, close,
  }));
}

describe("strategy signal generation", () => {
  it("emits a long signal on a sustained uptrend", () => {
    const series = candles(Array.from({ length: 120 }, (_, i) => 500 + i * 1.5));
    const strategy = resolveStrategy("trend_ema", {});
    expect(strategy).not.toBeNull();
    const signal = strategy!.evaluate({ symbol: "R_100", candles: series, indicators: snapshot(series), params: {} });
    expect(signal.direction).toBe("long");
    expect(signal.reasons.length).toBeGreaterThan(0);
  });

  it("emits a short signal on a sustained downtrend", () => {
    const series = candles(Array.from({ length: 120 }, (_, i) => 700 - i * 1.5));
    const strategy = resolveStrategy("trend_ema", {});
    const signal = strategy!.evaluate({ symbol: "R_100", candles: series, indicators: snapshot(series), params: {} });
    expect(signal.direction).toBe("short");
  });

  it("stays flat when the market is genuinely range-bound", () => {
    const series = candles(Array.from({ length: 120 }, (_, i) => 600 + (i % 2 === 0 ? 0.1 : -0.1)));
    const strategy = resolveStrategy("trend_ema", {});
    const signal = strategy!.evaluate({ symbol: "R_100", candles: series, indicators: snapshot(series), params: {} });
    expect(signal.direction).toBe("flat");
  });

  it("exposes every built-in strategy so the UI list is truthful", () => {
    expect(BUILTIN_STRATEGIES.length).toBeGreaterThan(0);
    for (const b of BUILTIN_STRATEGIES) {
      const series = candles(Array.from({ length: 120 }, (_, i) => 500 + i * 1.5));
      const s = resolveStrategy(b.id, {});
      expect(s, `strategy ${b.id} should resolve`).not.toBeNull();
      const signal = s!.evaluate({ symbol: "R_100", candles: series, indicators: snapshot(series), params: {} });
      expect(["long", "short", "flat"]).toContain(signal.direction);
    }
  });
});
