import type { RiskConfig, RiskDecision, TradeIntent } from "../types.ts";

/**
 * The risk engine holds final veto authority. It is pure: all state arrives as
 * inputs so that every decision is reproducible and unit-testable.
 */

export interface RiskContext {
  /** Account equity in account currency. */
  equity: number;
  /** Realised P&L so far today (negative = loss). */
  dailyPnl: number;
  /** Current peak-to-trough drawdown as a fraction (0.1 = 10%). */
  currentDrawdown: number;
  /** Total notional of open positions. */
  openExposure: number;
  /** Number of currently open trades. */
  openTradeCount: number;
  /** Consecutive losing trades, most recent first. */
  consecutiveLosses: number;
  /** Set when the engine is halted for the day. */
  tradingHalted: boolean;
}

export interface RiskInput {
  intent: TradeIntent;
  config: RiskConfig;
  context: RiskContext;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function evaluateRisk({ intent, config, context }: RiskInput): RiskDecision {
  const reasons: string[] = [];
  const adjustments: string[] = [];

  // --- Hard vetoes -----------------------------------------------------------
  if (context.tradingHalted) reasons.push("Trading is halted (daily loss limit or manual halt).");

  if (config.allowedSymbols.length > 0 && !config.allowedSymbols.includes(intent.symbol)) {
    reasons.push(`Instrument ${intent.symbol} is not in the allowed instrument list.`);
  }

  if (intent.strategyId && config.allowedStrategies.length > 0 && !config.allowedStrategies.includes(intent.strategyId)) {
    reasons.push(`Strategy ${intent.strategyId} is not in the allowed strategy list.`);
  }

  if (!Number.isFinite(intent.amount) || intent.amount <= 0) {
    reasons.push("Trade amount must be a positive number.");
  }

  if (context.openTradeCount >= config.maxConcurrentTrades) {
    reasons.push(`Maximum concurrent trades reached (${config.maxConcurrentTrades}).`);
  }

  // Daily loss limit: block new trades once the realised loss exceeds the limit.
  const lossToday = context.dailyPnl < 0 ? -context.dailyPnl : 0;
  if (lossToday >= config.dailyLossLimit) {
    reasons.push(`Daily loss limit reached (${lossToday.toFixed(2)} >= ${config.dailyLossLimit}).`);
  }

  if (context.currentDrawdown >= config.maxDrawdown) {
    reasons.push(`Maximum drawdown reached (${(context.currentDrawdown * 100).toFixed(1)}% >= ${(config.maxDrawdown * 100).toFixed(1)}%).`);
  }

  // --- Size determination ----------------------------------------------------
  // Base risk budget from equity, then reduce for a losing streak, then clamp.
  let amount = Math.min(intent.amount, config.maxTradeAmount);

  const riskBudget = context.equity * config.riskPerTrade;
  if (amount > riskBudget && riskBudget > 0) {
    amount = riskBudget;
    adjustments.push(`Reduced to risk-per-trade budget (${riskBudget.toFixed(2)}).`);
  }

  if (context.consecutiveLosses > 0) {
    // De-risk after losses. Never increase size to recover losses (no martingale).
    const steps = Math.min(context.consecutiveLosses, 5);
    const factor = config.lossStreakDeRiskFactor ** steps;
    amount = amount * factor;
    adjustments.push(
      `De-risked after ${context.consecutiveLosses} consecutive loss(es): x${factor.toFixed(3)}.`,
    );
  }

  // Exposure ceiling on the incremental notional.
  const remainingExposure = config.maxExposure - context.openExposure;
  if (remainingExposure <= 0) {
    reasons.push(`Maximum exposure reached (${context.openExposure.toFixed(2)} >= ${config.maxExposure}).`);
  } else if (amount > remainingExposure) {
    amount = remainingExposure;
    adjustments.push(`Reduced to remaining exposure headroom (${remainingExposure.toFixed(2)}).`);
  }

  if (context.equity > 0 && amount > context.equity) {
    amount = context.equity;
    adjustments.push("Reduced to available equity.");
  }

  amount = Math.max(0, Number(amount.toFixed(2)));

  if (amount <= 0 && reasons.length === 0) {
    reasons.push("Computed trade size is zero after risk adjustments.");
  }

  const approved = reasons.length === 0 && amount > 0;
  return { approved, reasons, approvedAmount: approved ? amount : 0, adjustments };
}

/**
 * Current open exposure: the money at risk right now. Fixed-expiry contracts appear as
 * open orders, not rows in the position table, so the two are combined by taking the
 * larger — never the sum, which would double-count a position and its order.
 */
export function currentExposure(openOrderAmounts: number[], positionSizes: number[]): number {
  const sum = (xs: number[]) => xs.reduce((a, x) => a + Math.abs(Number(x) || 0), 0);
  return Math.max(sum(openOrderAmounts), sum(positionSizes));
}

/**
 * True when the losing streak has reached the configured stop. The risk engine already
 * de-risks each trade after a loss; this is the separate hard stop the owner configures.
 * A limit of zero disables the stop.
 */
export function lossStreakBreached(consecutiveLosses: number, limit: number): boolean {
  return limit > 0 && consecutiveLosses >= limit;
}

/** Peak-to-trough drawdown from an equity series (chronological order). */
export function drawdownFromEquity(series: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

export { clamp };
