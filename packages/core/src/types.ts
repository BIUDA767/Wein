/** Domain types shared by every service. These mirror the database schema in db/migrations. */

export type AssetClass = "forex" | "crypto" | "stocks" | "indices" | "commodities" | "synthetic";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "fixed_expiry";
export type OrderStatus =
  | "pending"
  | "submitted"
  | "open"
  | "partially_filled"
  | "filled"
  | "settled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "unknown";
export type TradeMode = "paper" | "live";

/**
 * How much authority PHIRST2 has to act on its own. This is a separate axis from
 * `TradeMode` (paper vs live, which is about *where* an order is sent). The mode is
 * enforced by the backend, not by the UI.
 *
 * - manual      PHIRST2 analyses and recommends; only the owner executes.
 * - approval    PHIRST2 prepares a concrete proposal; the owner approves each one.
 * - autonomous  PHIRST2 executes qualifying trades within the configured limits.
 */
export type TradingMode = "manual" | "approval" | "autonomous";

export const TRADING_MODES: TradingMode[] = ["manual", "approval", "autonomous"];

export function isTradingMode(v: unknown): v is TradingMode {
  return v === "manual" || v === "approval" || v === "autonomous";
}

/** Status of a prepared trade awaiting the owner's decision. */
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "blocked";

export interface TradeProposal {
  id: string;
  symbol: string;
  side: OrderSide;
  amount: number;
  durationSec: number;
  strategyId: string | null;
  rationale: string | null;
  mode: TradeMode;
  status: ProposalStatus;
  /** Price at the time the proposal was prepared, used to expire stale ones. */
  referencePrice: number | null;
  /** Set when the proposal was blocked by the validation layer. */
  blockReason: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  orderId: string | null;
}

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  market?: string;
  pipSize?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  tradeable: boolean;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  epochMs: number;
}

export interface Candle {
  epoch: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BrokerAccount {
  id: string; // broker's account identifier
  type: "demo" | "real";
  currency: string;
  balance: number | null;
  loginid?: string;
  label?: string;
  /** Provider-reported account status, e.g. Deriv's "active". Null when not reported. */
  status?: string | null;
}

export interface TradeIntent {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  /** Stake / notional in account currency. */
  amount: number;
  /** For fixed-expiry contracts: duration in seconds. */
  durationSec?: number;
  /** Barrier / target used by some contract types. */
  barrier?: number | null;
  strategyId?: string;
  rationale?: string;
  /** Where the intent originated: manual UI action, engine, telegram, agent. */
  origin: "manual" | "engine" | "telegram" | "agent";
  mode: TradeMode;
  clientRef?: string;
}

export interface OrderRecord {
  id: string;
  brokerOrderId: string | null;
  brokerId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  amount: number;
  durationSec: number | null;
  status: OrderStatus;
  fillPrice: number | null;
  payout: number | null;
  profit: number | null;
  mode: TradeMode;
  strategyId: string | null;
  origin: string;
  clientRef: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface RiskConfig {
  /** Fraction of account equity risked per trade, e.g. 0.01 = 1%. */
  riskPerTrade: number;
  /** Absolute daily loss in account currency that halts trading for the day. */
  dailyLossLimit: number;
  /** Max peak-to-trough drawdown fraction before halting, e.g. 0.2 = 20%. */
  maxDrawdown: number;
  /** Max total notional exposure across open positions. */
  maxExposure: number;
  /** Max simultaneously open trades. */
  maxConcurrentTrades: number;
  /** Consecutive losses that trigger a pause. */
  consecutiveLossLimit: number;
  /** Exposure multiplier applied after a losing streak (must be <= 1). */
  lossStreakDeRiskFactor: number;
  /** Hard ceiling on a single trade amount, enforced regardless of riskPerTrade. */
  maxTradeAmount: number;
  allowedSymbols: string[];
  allowedStrategies: string[];
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  riskPerTrade: 0.01,
  dailyLossLimit: 500,
  maxDrawdown: 0.2,
  maxExposure: 2000,
  maxConcurrentTrades: 3,
  consecutiveLossLimit: 4,
  lossStreakDeRiskFactor: 0.5,
  maxTradeAmount: 250,
  allowedSymbols: [],
  allowedStrategies: [],
};

export interface RiskDecision {
  approved: boolean;
  reasons: string[];
  /** Amount the engine is allowed to use, after all reductions. */
  approvedAmount: number;
  adjustments: string[];
}

export type SignalDirection = "long" | "short" | "flat";
export interface StrategySignal {
  strategyId: string;
  symbol: string;
  direction: SignalDirection;
  confidence: number; // 0..1
  entry?: number;
  stop?: number;
  target?: number;
  durationSec?: number;
  reasons: string[];
  at: string;
}

export type AgentName =
  | "market_intelligence"
  | "technical_analysis"
  | "quantitative_analysis"
  | "sentiment_analysis"
  | "strategy_management"
  | "risk_management"
  | "execution_management"
  | "performance_analysis";

export interface AgentVerdict {
  agent: AgentName;
  /** true = supportive of the proposed action, false = opposed. */
  supportive: boolean;
  confidence: number;
  summary: string;
  detail?: Record<string, unknown>;
  /** Marks LLM-generated content so the UI can distinguish opinion from measured fact. */
  source: "deterministic" | "llm";
  at: string;
}

export type EngineState = "stopped" | "running" | "paused" | "halted" | "emergency";
