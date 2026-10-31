import { describe, it, expect } from "vitest";
import { evaluateRisk, drawdownFromEquity, currentExposure, lossStreakBreached, DEFAULT_RISK_CONFIG, type RiskConfig, type RiskContext, type TradeIntent } from "@phirst/core";

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    equity: 10_000,
    dailyPnl: 0,
    currentDrawdown: 0,
    openExposure: 0,
    openTradeCount: 0,
    consecutiveLosses: 0,
    tradingHalted: false,
    ...over,
  };
}

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  return { symbol: "R_100", side: "buy", orderType: "fixed_expiry", amount: 100, durationSec: 60, origin: "manual", mode: "paper", ...over };
}

const cfg = (over: Partial<RiskConfig> = {}): RiskConfig => ({ ...DEFAULT_RISK_CONFIG, ...over });

describe("evaluateRisk vetoes", () => {
  it("approves a modest trade inside all limits", () => {
    const d = evaluateRisk({ intent: intent({ amount: 50 }), config: cfg(), context: ctx() });
    expect(d.approved).toBe(true);
    expect(d.approvedAmount).toBe(50);
    expect(d.reasons).toEqual([]);
  });

  it("vetoes when trading is halted", () => {
    const d = evaluateRisk({ intent: intent(), config: cfg(), context: ctx({ tradingHalted: true }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/halted/i);
  });

  it("vetoes a symbol outside the allowed list", () => {
    const d = evaluateRisk({ intent: intent({ symbol: "EURUSD" }), config: cfg({ allowedSymbols: ["R_100"] }), context: ctx() });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/allowed instrument/i);
  });

  it("vetoes a strategy outside the allowed list", () => {
    const d = evaluateRisk({ intent: intent({ strategyId: "macd_momentum" }), config: cfg({ allowedStrategies: ["trend_ema"] }), context: ctx() });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/allowed strategy/i);
  });

  it("vetoes a non-positive amount", () => {
    expect(evaluateRisk({ intent: intent({ amount: 0 }), config: cfg(), context: ctx() }).approved).toBe(false);
    expect(evaluateRisk({ intent: intent({ amount: -5 }), config: cfg(), context: ctx() }).approved).toBe(false);
  });

  it("vetoes when the concurrent trade cap is reached", () => {
    const d = evaluateRisk({ intent: intent(), config: cfg({ maxConcurrentTrades: 2 }), context: ctx({ openTradeCount: 2 }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/concurrent/i);
  });

  it("vetoes once the daily loss limit is reached", () => {
    const d = evaluateRisk({ intent: intent(), config: cfg({ dailyLossLimit: 100 }), context: ctx({ dailyPnl: -100 }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/daily loss limit/i);
  });

  it("vetoes once the drawdown cap is reached", () => {
    const d = evaluateRisk({ intent: intent(), config: cfg({ maxDrawdown: 0.1 }), context: ctx({ currentDrawdown: 0.12 }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/drawdown/i);
  });

  it("vetoes when exposure is already at the ceiling", () => {
    const d = evaluateRisk({ intent: intent(), config: cfg({ maxExposure: 500 }), context: ctx({ openExposure: 500 }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/exposure/i);
  });
});

describe("evaluateRisk sizing", () => {
  it("clamps to the per-trade hard ceiling", () => {
    const d = evaluateRisk({ intent: intent({ amount: 9999 }), config: cfg({ maxTradeAmount: 200, riskPerTrade: 1 }), context: ctx() });
    expect(d.approvedAmount).toBe(200);
  });

  it("clamps to the risk-per-trade budget", () => {
    const d = evaluateRisk({ intent: intent({ amount: 9999 }), config: cfg({ maxTradeAmount: 5000, riskPerTrade: 0.01 }), context: ctx({ equity: 10_000 }) });
    // 1% of 10,000 = 100
    expect(d.approvedAmount).toBe(100);
    expect(d.adjustments.join(" ")).toMatch(/risk-per-trade/i);
  });

  it("de-risks after consecutive losses and never increases size", () => {
    const base = evaluateRisk({ intent: intent({ amount: 100 }), config: cfg(), context: ctx({ consecutiveLosses: 0 }) });
    const after2 = evaluateRisk({ intent: intent({ amount: 100 }), config: cfg(), context: ctx({ consecutiveLosses: 2 }) });
    expect(after2.approvedAmount).toBeLessThan(base.approvedAmount);
    // 0.5^2 = 0.25
    expect(after2.approvedAmount).toBe(25);
    expect(after2.adjustments.join(" ")).toMatch(/de-risked/i);
  });

  it("never produces an amount larger than the request after de-risking", () => {
    for (let losses = 0; losses <= 6; losses++) {
      const d = evaluateRisk({ intent: intent({ amount: 100 }), config: cfg(), context: ctx({ consecutiveLosses: losses }) });
      expect(d.approvedAmount).toBeLessThanOrEqual(100);
    }
  });

  it("trims to remaining exposure headroom", () => {
    const d = evaluateRisk({
      intent: intent({ amount: 300 }),
      config: cfg({ maxExposure: 1000, maxTradeAmount: 500, riskPerTrade: 1 }),
      context: ctx({ openExposure: 900 }),
    });
    expect(d.approvedAmount).toBe(100);
    expect(d.adjustments.join(" ")).toMatch(/headroom/i);
  });

  it("never approves more than the account equity", () => {
    const d = evaluateRisk({ intent: intent({ amount: 500 }), config: cfg({ maxTradeAmount: 1000, maxExposure: 10_000 }), context: ctx({ equity: 50 }) });
    expect(d.approvedAmount).toBeLessThanOrEqual(50);
  });

  it("rounds the approved amount to two decimals", () => {
    const d = evaluateRisk({ intent: intent({ amount: 33.333333 }), config: cfg(), context: ctx() });
    expect(d.approvedAmount).toBe(33.33);
  });
});

describe("drawdownFromEquity", () => {
  it("computes peak-to-trough drawdown", () => {
    expect(drawdownFromEquity([100, 120, 90, 110])).toBeCloseTo(0.25, 6);
  });
  it("is zero for a monotonically rising series", () => {
    expect(drawdownFromEquity([100, 110, 120])).toBe(0);
  });
  it("handles an empty series", () => {
    expect(drawdownFromEquity([])).toBe(0);
  });
});

describe("currentExposure", () => {
  it("counts open fixed-expiry contracts, which live in orders not positions", () => {
    expect(currentExposure([60, 60, 60], [])).toBe(180);
  });
  it("does not double-count when a position mirrors its order", () => {
    expect(currentExposure([100], [100])).toBe(100);
  });
  it("uses the position view when it is larger (e.g. running contracts)", () => {
    expect(currentExposure([], [250])).toBe(250);
  });
  it("is zero with nothing open", () => {
    expect(currentExposure([], [])).toBe(0);
  });
  it("treats a missing or non-numeric size as zero", () => {
    expect(currentExposure([Number(undefined)], [Number("abc")])).toBe(0);
  });
});

describe("lossStreakBreached", () => {
  it("fires at the limit", () => {
    expect(lossStreakBreached(4, 4)).toBe(true);
  });
  it("fires beyond the limit", () => {
    expect(lossStreakBreached(5, 4)).toBe(true);
  });
  it("does not fire below the limit", () => {
    expect(lossStreakBreached(3, 4)).toBe(false);
  });
  it("is disabled when the limit is zero", () => {
    expect(lossStreakBreached(10, 0)).toBe(false);
  });
  it("does not fire with no losses", () => {
    expect(lossStreakBreached(0, 4)).toBe(false);
  });
});

describe("exposure ceiling binds on open contracts", () => {
  it("vetoes once open contract exposure reaches the ceiling", () => {
    // Regression: exposure was read from the position table, which is empty for
    // fixed-expiry contracts, so maxExposure never blocked anything.
    const openExposure = currentExposure([60, 60], []);
    const d = evaluateRisk({ intent: intent({ amount: 60 }), config: cfg({ maxExposure: 100 }), context: ctx({ openExposure }) });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/exposure/i);
  });
});
