/**
 * Typed API client. All requests are same-origin (proxied by Next) so the session
 * cookie is first-party. Every method surfaces the server's error message verbatim.
 */
export interface ApiError {
  status: number;
  message: string;
  extra?: Record<string, unknown>;
}

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
    this.name = "ApiFailure";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const obj = (data ?? {}) as Record<string, unknown>;
    throw new ApiFailure(res.status, String(obj.error ?? `HTTP ${res.status}`), obj);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// --- Response types (mirrors the API) ----------------------------------------

export interface EngineStatus {
  state: "stopped" | "running" | "paused" | "halted" | "emergency";
  mode: "paper" | "live";
  reason: string | null;
  symbol: string;
  equity: number;
  balance: number;
  unrealized: number;
  dailyPnl: number;
  drawdown: number;
  openTrades: number;
  consecutiveLosses: number;
  lastSignal: { direction: string; confidence: number; reasons: string[] } | null;
  lastVerdicts: Array<{
    agent: string;
    supportive: boolean;
    confidence: number;
    summary: string;
    source: "deterministic" | "llm";
    at: string;
  }>;
  brokerConnected: boolean;
  brokerName: string | null;
  activeStrategyId: string | null;
  lastPrice: number | null;
  emergencyStop: boolean;
  updatedAt: string;
}

export interface RiskConfig {
  riskPerTrade: number;
  dailyLossLimit: number;
  maxDrawdown: number;
  maxExposure: number;
  maxConcurrentTrades: number;
  consecutiveLossLimit: number;
  lossStreakDeRiskFactor: number;
  maxTradeAmount: number;
  allowedSymbols: string[];
  allowedStrategies: string[];
}

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: string;
  tradeable: boolean;
}

export interface Candle { epoch: number; open: number; high: number; low: number; close: number }

export interface BrokerRecord {
  id: string;
  provider: string;
  label: string;
  status: string;
  isActive: boolean;
  credentialFingerprint: string;
  lastVerifiedAt: string | null;
  lastError: string | null;
  capabilities: Record<string, unknown>;
  createdAt: string;
}

export interface ProviderSpec {
  id: string;
  name: string;
  assetClasses: string[];
  implemented: boolean;
  requires: string[];
  fiveSecondExpiry: boolean;
  docsUrl: string;
  notes: string;
}

export interface AccountRecord {
  id: string;
  broker_id: string;
  account_id: string;
  account_type: "demo" | "real";
  currency: string;
  balance: string | number | null;
  loginid: string | null;
  label: string | null;
  is_active: boolean;
}

export interface OrderRecord {
  id: string;
  broker_order_id: string | null;
  symbol: string;
  side: string;
  order_type: string;
  amount: string | number;
  duration_sec: number | null;
  status: string;
  fill_price: string | number | null;
  payout: string | number | null;
  profit: string | number | null;
  mode: string;
  strategy_id: string | null;
  origin: string;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface PositionRecord {
  id: string;
  symbol: string;
  side: string;
  size: string | number;
  entry_price: string | number | null;
  current_price: string | number | null;
  unrealized_pnl: string | number | null;
  mode: string;
  updated_at: string;
}

export interface StrategyRecord {
  id: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
  enabled: boolean;
  builtin: boolean;
  is_active: boolean;
}

export interface NotificationRecord {
  id: string;
  severity: string;
  title: string;
  body: string;
  category: string;
  read_at: string | null;
  created_at: string;
}

export interface PhirstFacts {
  engineState: string;
  mode: string;
  equity: number | null;
  balance: number | null;
  openTrades: number;
  dailyPnl: number | null;
  brokerConnected: boolean;
  brokerName: string | null;
  activeStrategy: string | null;
  activeSymbol: string | null;
  lastPrice: number | null;
  emergencyStop: boolean;
}

export interface MemoryRecord {
  id: string;
  kind: string;
  content: string;
  importance: number;
  source: string;
  created_at: string;
}

export interface VoiceSettings {
  enabled: boolean;
  voice: "male" | "female";
  accent: string;
  rate: number;
  pitch: number;
  pushToTalk: boolean;
  handsFree: boolean;
  autoSpeakAlerts: boolean;
}

export interface UiPreferences {
  defaultAmount: number;
  defaultDurationSec: number;
  chartStyle: "candles" | "hollow" | "line" | "area";
  chartGrid: boolean;
  chartHeight: number;
  defaultIndicators: string[];
  timeframes: number[];
  dashboardTiles: string[];
  reducedMotion: boolean;
  soundEnabled: boolean;
  soundVolume: number;
}

export interface ChatReply {
  reply: string;
  source: "llm" | "fallback";
  model: string | null;
  urgency: "normal" | "attention" | "critical";
  error: string | null;
  facts: PhirstFacts;
}

export interface PerformanceReport {
  mode: string;
  totalTrades: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  byStrategy: Array<{ strategyId: string; trades: number; pnl: number }>;
}

export interface TelegramStatus {
  configured: boolean;
  running: boolean;
  lastError: string | null;
  botUsername: string | null;
  updatesProcessed: number;
  links: Array<{ chatId: string; permissions: string[]; updatedAt: string }>;
  availablePermissions: string[];
}
