import { describe, it, expect } from "vitest";
import { GeminiClient, runAgentPanel, aggregatePanel, evaluateProactiveAlerts, phirstReply, buildSystemPrompt, technicalAnalysis, riskManagement, executionManagement, performanceAnalysis, type AgentContext, type TradeHistoryStats } from "@phirst/ai";
import { snapshot, evaluateRisk, DEFAULT_RISK_CONFIG, type Candle, type StrategySignal } from "@phirst/core";

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ epoch: 1_700_000_000 + i * 60, open: c, high: c + 0.5, low: c - 0.5, close: c }));
}

const upSeries = candles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.4));
const signal: StrategySignal = { strategyId: "trend_ema", symbol: "R_100", direction: "long", confidence: 0.7, reasons: ["test"], at: new Date().toISOString() };

function history(over: Partial<TradeHistoryStats> = {}): TradeHistoryStats {
  return { totalTrades: 30, wins: 18, losses: 12, netPnl: 250, winRate: 0.6, avgWin: 30, avgLoss: -20, profitFactor: 1.5, expectancy: 8, ...over };
}

function makeCtx(over: Partial<AgentContext> = {}): AgentContext {
  const ind = snapshot(upSeries);
  const risk = evaluateRisk({
    intent: { symbol: "R_100", side: "buy", orderType: "fixed_expiry", amount: 50, durationSec: 60, origin: "engine", mode: "paper" },
    config: DEFAULT_RISK_CONFIG,
    context: { equity: 10_000, dailyPnl: 0, currentDrawdown: 0, openExposure: 0, openTradeCount: 0, consecutiveLosses: 0, tradingHalted: false },
  });
  return {
    symbol: "R_100",
    candles: upSeries,
    indicators: ind,
    signal,
    risk,
    equity: 10_000,
    openTradeCount: 0,
    history: history(),
    brokerConnected: true,
    brokerCapabilities: { minExpirySec: 5, fixedExpiry: true, marketData: true },
    requestedDurationSec: 60,
    llm: new GeminiClient({ apiKey: null, model: "gemini-2.5-flash" }),
    ...over,
  };
}

describe("agent panel", () => {
  it("runs all eight agents and returns verdicts", async () => {
    const panel = await runAgentPanel(makeCtx());
    expect(panel.verdicts.length).toBe(8);
    const names = new Set(panel.verdicts.map((v) => v.agent));
    expect(names.size).toBe(8);
  });

  it("labels deterministic agents and the LLM agent distinctly", async () => {
    const panel = await runAgentPanel(makeCtx());
    const sentiment = panel.verdicts.find((v) => v.agent === "sentiment_analysis")!;
    expect(sentiment.source).toBe("llm");
    for (const v of panel.verdicts.filter((x) => x.agent !== "sentiment_analysis")) {
      expect(v.source).toBe("deterministic");
    }
  });

  it("reports sentiment as unavailable (not invented) when there is no API key", async () => {
    const panel = await runAgentPanel(makeCtx());
    expect(panel.llmUnavailable).toBe(true);
    const sentiment = panel.verdicts.find((v) => v.agent === "sentiment_analysis")!;
    expect(sentiment.detail?.unavailable).toBe(true);
    expect(sentiment.summary).toMatch(/unavailable/i);
  });

  it("technical analysis confirms an aligned uptrend signal", () => {
    const v = technicalAnalysis(makeCtx());
    expect(v.supportive).toBe(true);
    expect(v.confidence).toBeGreaterThan(0.5);
  });

  it("risk management agent mirrors a risk veto", () => {
    const ctx = makeCtx({
      risk: { approved: false, approvedAmount: 0, reasons: ["Maximum concurrent trades reached (1)."], adjustments: [] },
    });
    const v = riskManagement(ctx);
    expect(v.supportive).toBe(false);
    expect(v.summary).toMatch(/veto/i);
  });

  it("execution agent blocks a duration below the broker minimum", () => {
    const v = executionManagement(makeCtx({ requestedDurationSec: 1, brokerCapabilities: { minExpirySec: 5, fixedExpiry: true, marketData: true } }));
    expect(v.supportive).toBe(false);
    expect(v.summary).toMatch(/below the broker minimum/i);
  });

  it("execution agent blocks when the broker is disconnected", () => {
    const v = executionManagement(makeCtx({ brokerConnected: false }));
    expect(v.supportive).toBe(false);
  });

  it("performance agent flags deterioration with a bad profit factor", () => {
    const v = performanceAnalysis(makeCtx({ history: history({ profitFactor: 0.6, expectancy: -5, winRate: 0.3 }) }));
    expect(v.supportive).toBe(false);
    expect(v.summary).toMatch(/deteriorating/i);
  });

  it("performance agent abstains with too few trades", () => {
    const v = performanceAnalysis(makeCtx({ history: history({ totalTrades: 2 }) }));
    expect(v.summary).toMatch(/not yet meaningful/i);
  });

  it("aggregatePanel counts supportive and opposed verdicts", () => {
    const agg = aggregatePanel([
      { agent: "technical_analysis", supportive: true, confidence: 0.8, summary: "a", source: "deterministic", at: "" },
      { agent: "risk_management", supportive: false, confidence: 0.9, summary: "b", source: "deterministic", at: "" },
    ]);
    expect(agg.supportiveCount).toBe(1);
    expect(agg.opposedCount).toBe(1);
    expect(agg.averageConfidence).toBeCloseTo(0.85, 6);
  });
});

describe("PHIRST2 companion", () => {
  const facts = {
    engineState: "running" as const,
    mode: "paper" as const,
    equity: 10_250,
    balance: 10_000,
    openTrades: 2,
    dailyPnl: 250,
    brokerConnected: true,
    brokerName: "Deriv",
    activeStrategy: "trend_ema",
    activeSymbol: "R_100",
    lastPrice: 582.85,
    risk: { maxConcurrentTrades: 3, dailyLossLimit: 500, riskPerTrade: 0.01, maxDrawdown: 0.2 },
    recentVerdicts: [],
    emergencyStop: false,
  };

  it("system prompt includes measured facts and the hard rules", () => {
    const p = buildSystemPrompt(facts, ["BAELAY prefers paper mode first"]);
    expect(p).toContain("PHIRST2");
    expect(p).toContain("BAELAY");
    expect(p).toContain("Equity: 10250.00");
    expect(p).toContain("Never invent");
    expect(p).toContain("BAELAY prefers paper mode first");
  });

  it("falls back to measured facts when no LLM is configured", async () => {
    const reply = await phirstReply("what is my balance?", facts, [], new GeminiClient({ apiKey: null, model: "m" }));
    expect(reply.source).toBe("fallback");
    expect(reply.reply).toContain("10250.00");
  });

  it("reports risk values on request without an LLM", async () => {
    const reply = await phirstReply("what is my risk?", facts, [], new GeminiClient({ apiKey: null, model: "m" }));
    expect(reply.reply).toMatch(/daily loss limit is 500/);
  });

  it("escalates urgency to critical when the emergency stop is engaged", async () => {
    const reply = await phirstReply("status", { ...facts, emergencyStop: true }, [], new GeminiClient({ apiKey: null, model: "m" }));
    expect(reply.urgency).toBe("critical");
  });
});

describe("proactive alerts", () => {
  const base = {
    engineState: "running" as const,
    mode: "paper" as const,
    equity: 1000,
    balance: 1000,
    openTrades: 0,
    dailyPnl: 0,
    brokerConnected: true,
    brokerName: "Deriv",
    activeStrategy: "trend_ema",
    activeSymbol: "R_100",
    lastPrice: 1,
    risk: { maxConcurrentTrades: 3, dailyLossLimit: 500, riskPerTrade: 0.01, maxDrawdown: 0.2 },
    recentVerdicts: [],
    emergencyStop: false,
  };

  it("fires nothing when everything is healthy", () => {
    expect(evaluateProactiveAlerts(base)).toEqual([]);
  });

  it("fires a critical alert when the emergency stop is engaged", () => {
    const alerts = evaluateProactiveAlerts({ ...base, emergencyStop: true });
    expect(alerts.some((a) => a.trigger === "emergency_stop" && a.severity === "critical")).toBe(true);
  });

  it("fires when the broker drops while running", () => {
    const alerts = evaluateProactiveAlerts({ ...base, brokerConnected: false });
    expect(alerts.some((a) => a.trigger === "broker_disconnected")).toBe(true);
  });

  it("fires a warning as the daily loss limit approaches", () => {
    const alerts = evaluateProactiveAlerts({ ...base, dailyPnl: -420 });
    expect(alerts.some((a) => a.trigger === "daily_loss" && a.severity === "warning")).toBe(true);
  });
});
