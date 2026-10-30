import { describe, it, expect } from "vitest";
import { BUILTIN_STRATEGIES, getBuiltin, resolveStrategy, snapshot, type Candle } from "@phirst/core";

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ epoch: 1_700_000_000 + i * 60, open: c, high: c + 0.4, low: c - 0.4, close: c }));
}

describe("strategy registry", () => {
  it("exposes five built-in strategies with unique ids", () => {
    expect(BUILTIN_STRATEGIES.length).toBe(5);
    const ids = new Set(BUILTIN_STRATEGIES.map((s) => s.id));
    expect(ids.size).toBe(5);
  });

  it("finds a built-in by id and returns undefined otherwise", () => {
    expect(getBuiltin("trend_ema")?.name).toBe("EMA Trend Rider");
    expect(getBuiltin("nope")).toBeUndefined();
  });

  it("resolves a custom strategy as a template plus overrides", () => {
    const custom = resolveStrategy("custom:trend_ema", { minTrend: 0.02 });
    expect(custom).not.toBeNull();
    expect(custom!.defaultParams.minTrend).toBe(0.02);
    expect(custom!.id).toBe("custom:trend_ema");
  });

  it("returns null for an unknown template", () => {
    expect(resolveStrategy("custom:does_not_exist", {})).toBeNull();
  });
});

describe("strategy signals", () => {
  const up = candles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5));
  const down = candles(Array.from({ length: 120 }, (_, i) => 200 - i * 0.5));

  it("every strategy returns a well-formed signal", () => {
    for (const s of BUILTIN_STRATEGIES) {
      for (const series of [up, down]) {
        const sig = s.evaluate({ symbol: "R_100", candles: series, indicators: snapshot(series), params: s.defaultParams });
        expect(sig.strategyId).toBe(s.id);
        expect(["long", "short", "flat"]).toContain(sig.direction);
        expect(sig.confidence).toBeGreaterThanOrEqual(0);
        expect(sig.confidence).toBeLessThanOrEqual(1);
        expect(sig.reasons.length).toBeGreaterThan(0);
        expect(sig.at).toMatch(/^\d{4}-/);
      }
    }
  });

  it("EMA trend goes long in a sustained uptrend", () => {
    const s = getBuiltin("trend_ema")!;
    const sig = s.evaluate({ symbol: "R_100", candles: up, indicators: snapshot(up), params: s.defaultParams });
    expect(sig.direction).toBe("long");
  });

  it("EMA trend goes short in a sustained downtrend", () => {
    const s = getBuiltin("trend_ema")!;
    const sig = s.evaluate({ symbol: "R_100", candles: down, indicators: snapshot(down), params: s.defaultParams });
    expect(sig.direction).toBe("short");
  });

  it("returns flat rather than guessing when data is insufficient", () => {
    const tiny = candles([1, 2, 3]);
    for (const s of BUILTIN_STRATEGIES) {
      const sig = s.evaluate({ symbol: "R_100", candles: tiny, indicators: snapshot(tiny), params: s.defaultParams });
      expect(sig.direction).toBe("flat");
    }
  });
});
