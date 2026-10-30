import type { AgentName, AgentVerdict, Candle, IndicatorSnapshot, RiskDecision, StrategySignal } from "@phirst/core";
import type { GeminiClient } from "./gemini.ts";

/**
 * The agent panel. Deterministic agents compute facts from measured data and are
 * always available. LLM agents add opinion and are clearly marked as such; when the
 * model is unavailable they report that rather than inventing a view.
 *
 * The panel is advisory. The risk engine, not the panel, holds final veto authority.
 */

export interface TradeHistoryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancy: number;
}

export interface AgentContext {
  symbol: string;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  signal: StrategySignal;
  risk: RiskDecision;
  equity: number;
  openTradeCount: number;
  history: TradeHistoryStats;
  brokerConnected: boolean;
  brokerCapabilities: { minExpirySec: number | null; fixedExpiry: boolean; marketData: boolean };
  requestedDurationSec: number | null;
  llm: GeminiClient;
}

const now = () => new Date().toISOString();

function verdict(
  agent: AgentName,
  supportive: boolean,
  confidence: number,
  summary: string,
  source: "deterministic" | "llm",
  detail?: Record<string, unknown>,
): AgentVerdict {
  return { agent, supportive, confidence: Math.max(0, Math.min(1, confidence)), summary, source, detail, at: now() };
}

// --- 1. Technical analysis (deterministic) ------------------------------------

export function technicalAnalysis(ctx: AgentContext): AgentVerdict {
  const { indicators: i, signal } = ctx;
  if (i.rsi === null || !i.macd || i.emaFast === null || i.emaSlow === null) {
    return verdict("technical_analysis", false, 0, "Insufficient candles to compute a technical view.", "deterministic");
  }
  const bullish = i.emaFast > i.emaSlow && i.macd.histogram > 0;
  const bearish = i.emaFast < i.emaSlow && i.macd.histogram < 0;
  const agrees = (signal.direction === "long" && bullish) || (signal.direction === "short" && bearish);
  const rsiExtreme = i.rsi > 75 || i.rsi < 25;
  const summary = agrees
    ? `Indicators align with the ${signal.direction} signal (EMA ${i.emaFast.toFixed(3)}/${i.emaSlow.toFixed(3)}, MACD histogram ${i.macd.histogram.toFixed(4)}, RSI ${i.rsi.toFixed(1)}).`
    : `Indicators do not confirm the ${signal.direction} signal (EMA ${i.emaFast.toFixed(3)}/${i.emaSlow.toFixed(3)}, MACD histogram ${i.macd.histogram.toFixed(4)}, RSI ${i.rsi.toFixed(1)}).`;
  return verdict("technical_analysis", agrees, agrees ? 0.6 + signal.confidence * 0.3 : 0.2, summary, "deterministic", {
    rsi: i.rsi,
    macdHistogram: i.macd.histogram,
    emaFast: i.emaFast,
    emaSlow: i.emaSlow,
    rsiExtreme,
  });
}

// --- 2. Quantitative analysis (deterministic) ---------------------------------

export function quantitativeAnalysis(ctx: AgentContext): AgentVerdict {
  const { indicators: i, candles } = ctx;
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  for (let k = 1; k < closes.length; k++) {
    if (closes[k - 1]! > 0) rets.push(Math.log(closes[k]! / closes[k - 1]!));
  }
  if (rets.length < 10 || i.volatility === null || i.atr === null) {
    return verdict("quantitative_analysis", false, 0, "Insufficient returns to estimate a statistical edge.", "deterministic");
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const z = sd > 0 ? mean / (sd / Math.sqrt(rets.length)) : 0;
  // A statistically meaningful drift favours a trend signal; otherwise be cautious.
  const meaningful = Math.abs(z) > 1.5;
  const supportive = meaningful && ((z > 0 && ctx.signal.direction === "long") || (z < 0 && ctx.signal.direction === "short"));
  return verdict(
    "quantitative_analysis",
    supportive,
    Math.min(1, Math.abs(z) / 3),
    supportive
      ? `Return drift is statistically meaningful (t≈${z.toFixed(2)}), annualised volatility ${(i.volatility * 100).toFixed(1)}%.`
      : `No statistically meaningful drift (t≈${z.toFixed(2)}); treat the signal as low-conviction.`,
    "deterministic",
    { tStat: z, volatility: i.volatility, atr: i.atr, samples: rets.length },
  );
}

// --- 3. Market intelligence (deterministic regime + optional LLM commentary) --

export function marketIntelligence(ctx: AgentContext): AgentVerdict {
  const { indicators: i, candles } = ctx;
  const closes = candles.map((c) => c.close);
  const recent = closes.slice(-20);
  const older = closes.slice(-40, -20);
  const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const olderAvg = older.length ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;
  const change = olderAvg !== 0 ? (recentAvg - olderAvg) / olderAvg : 0;
  const vol = i.volatility ?? 0;
  const regime = Math.abs(change) < 0.001 ? "range" : change > 0 ? "uptrend" : "downtrend";
  const volRegime = vol > 1 ? "high volatility" : vol > 0.3 ? "normal volatility" : "low volatility";
  const supportive = (regime === "uptrend" && ctx.signal.direction === "long") || (regime === "downtrend" && ctx.signal.direction === "short");
  return verdict(
    "market_intelligence",
    supportive,
    0.5,
    `Measured regime: ${regime} with ${volRegime} (20-bar change ${(change * 100).toFixed(3)}%, annualised vol ${(vol * 100).toFixed(1)}%).`,
    "deterministic",
    { regime, volRegime, change20: change, volatility: vol },
  );
}

// --- 4. Sentiment analysis (LLM opinion, clearly labelled) --------------------

export async function sentimentAnalysis(ctx: AgentContext): Promise<AgentVerdict> {
  if (!ctx.llm.available) {
    return verdict(
      "sentiment_analysis",
      true,
      0,
      "Sentiment analysis unavailable: GEMINI_API_KEY is not configured. No sentiment view is being assumed.",
      "llm",
      { unavailable: true },
    );
  }
  const prompt = `You are the sentiment analysis agent for a trading system. Assess crowd/news sentiment for ${ctx.symbol}.
Recent price context: last close ${ctx.indicators.price}, RSI ${ctx.indicators.rsi?.toFixed(1) ?? "n/a"}, annualised volatility ${ctx.indicators.volatility?.toFixed(3) ?? "n/a"}.
Return strict JSON: {"supportive": boolean, "confidence": number between 0 and 1, "summary": "one sentence"}.
"supportive" means sentiment favours the proposed ${ctx.signal.direction} direction. Base this only on general market knowledge; do not invent specific news items.`;
  const res = await ctx.llm.generateJson<{ supportive: boolean; confidence: number; summary: string }>(prompt, {
    system: "You are a cautious markets analyst. You never fabricate news. You return only valid JSON.",
    temperature: 0.2,
  });
  if (!res.ok || !res.value) {
    return verdict("sentiment_analysis", true, 0, `Sentiment unavailable: ${res.error}`, "llm", { unavailable: true });
  }
  return verdict(
    "sentiment_analysis",
    Boolean(res.value.supportive),
    Number(res.value.confidence ?? 0.4),
    `Opinion (${res.model}): ${res.value.summary}`,
    "llm",
    { model: res.model },
  );
}

// --- 5. Risk management (deterministic, mirrors the risk engine) --------------

export function riskManagement(ctx: AgentContext): AgentVerdict {
  const { risk } = ctx;
  if (!risk.approved) {
    return verdict("risk_management", false, 0, `Risk engine veto: ${risk.reasons.join(" ")}`, "deterministic", {
      reasons: risk.reasons,
      adjustments: risk.adjustments,
    });
  }
  const summary = risk.adjustments.length
    ? `Risk approved with adjustments: ${risk.adjustments.join(" ")} Approved amount ${risk.approvedAmount}.`
    : `Risk approved at ${risk.approvedAmount} with no adjustments.`;
  return verdict("risk_management", true, 0.9, summary, "deterministic", {
    approvedAmount: risk.approvedAmount,
    adjustments: risk.adjustments,
  });
}

// --- 6. Execution management (deterministic) ----------------------------------

export function executionManagement(ctx: AgentContext): AgentVerdict {
  const problems: string[] = [];
  if (!ctx.brokerConnected) problems.push("Broker is not connected.");
  if (!ctx.brokerCapabilities.marketData) problems.push("Broker does not provide market data.");
  if (ctx.requestedDurationSec !== null && ctx.brokerCapabilities.minExpirySec !== null && ctx.requestedDurationSec < ctx.brokerCapabilities.minExpirySec) {
    problems.push(
      `Requested duration ${ctx.requestedDurationSec}s is below the broker minimum of ${ctx.brokerCapabilities.minExpirySec}s.`,
    );
  }
  if (problems.length) {
    return verdict("execution_management", false, 0, `Execution blocked: ${problems.join(" ")}`, "deterministic", { problems });
  }
  return verdict(
    "execution_management",
    true,
    0.85,
    `Execution path ready: broker connected, market data live${ctx.requestedDurationSec !== null ? `, duration ${ctx.requestedDurationSec}s within broker limits` : ""}.`,
    "deterministic",
  );
}

// --- 7. Performance analysis (deterministic) ----------------------------------

export function performanceAnalysis(ctx: AgentContext): AgentVerdict {
  const h = ctx.history;
  if (h.totalTrades < 5) {
    return verdict("performance_analysis", true, 0.2, `Only ${h.totalTrades} settled trade(s) so far; performance statistics are not yet meaningful.`, "deterministic", {
      totalTrades: h.totalTrades,
    });
  }
  const deteriorating = h.profitFactor !== null && h.profitFactor < 1 && h.expectancy < 0;
  return verdict(
    "performance_analysis",
    !deteriorating,
    deteriorating ? 0.7 : 0.5,
    deteriorating
      ? `Strategy is deteriorating: ${h.totalTrades} trades, win rate ${(h.winRate * 100).toFixed(1)}%, profit factor ${h.profitFactor?.toFixed(2)}, expectancy ${h.expectancy.toFixed(2)}.`
      : `Strategy is holding up: ${h.totalTrades} trades, win rate ${(h.winRate * 100).toFixed(1)}%, net P&L ${h.netPnl.toFixed(2)}.`,
    "deterministic",
    { ...h },
  );
}

// --- 8. Strategy management (deterministic recommendation) --------------------

export function strategyManagement(ctx: AgentContext): AgentVerdict {
  const h = ctx.history;
  const recommendations: string[] = [];
  if (h.totalTrades >= 20 && h.profitFactor !== null && h.profitFactor < 1) {
    recommendations.push("Consider pausing this strategy or reducing size until the profit factor recovers above 1.0.");
  }
  if (h.totalTrades >= 20 && h.winRate < 0.4) {
    recommendations.push("Win rate is below 40%; tighten entry filters.");
  }
  if (h.totalTrades < 20) {
    recommendations.push("Sample size is too small to judge the strategy; continue in paper mode.");
  }
  return verdict(
    "strategy_management",
    true,
    0.5,
    recommendations.length ? `Recommendation: ${recommendations.join(" ")}` : "No strategy change recommended.",
    "deterministic",
    { recommendations },
  );
}

// --- Panel runner and aggregation ---------------------------------------------

export interface PanelResult {
  verdicts: AgentVerdict[];
  supportiveCount: number;
  opposedCount: number;
  averageConfidence: number;
  llmUnavailable: boolean;
}

export async function runAgentPanel(ctx: AgentContext): Promise<PanelResult> {
  const verdicts: AgentVerdict[] = [
    technicalAnalysis(ctx),
    quantitativeAnalysis(ctx),
    marketIntelligence(ctx),
    riskManagement(ctx),
    executionManagement(ctx),
    performanceAnalysis(ctx),
    strategyManagement(ctx),
    await sentimentAnalysis(ctx),
  ];
  return aggregatePanel(verdicts);
}

export function aggregatePanel(verdicts: AgentVerdict[]): PanelResult {
  const supportive = verdicts.filter((v) => v.supportive);
  const opposed = verdicts.filter((v) => !v.supportive);
  const confidenceVerdicts = verdicts.filter((v) => v.confidence > 0);
  const averageConfidence = confidenceVerdicts.length
    ? confidenceVerdicts.reduce((a, v) => a + v.confidence, 0) / confidenceVerdicts.length
    : 0;
  return {
    verdicts,
    supportiveCount: supportive.length,
    opposedCount: opposed.length,
    averageConfidence,
    llmUnavailable: verdicts.some((v) => v.agent === "sentiment_analysis" && v.detail?.unavailable === true),
  };
}
