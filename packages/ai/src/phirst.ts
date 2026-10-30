import type { AgentVerdict, EngineState, TradeMode } from "@phirst/core";
import type { GeminiClient } from "./gemini.ts";

/**
 * PHIRST2 is the application's AI companion: a private wealth manager for BAELAY.
 * Calm by default, assertive when an opportunity or a serious risk appears.
 *
 * Hard rules enforced here:
 *  - It may only speak about facts present in the supplied context.
 *  - It never invents trades, prices, balances or market events.
 *  - It distinguishes measured fact from its own opinion.
 *  - It never receives or repeats broker secrets.
 */
export const PHIRST2_IDENTITY = {
  name: "PHIRST2",
  user: "BAELAY",
  role: "Private wealth manager",
  temperament: "Calm in execution. Precise in judgement. Relentless in discipline.",
} as const;

export interface PhirstVoiceSettings {
  enabled: boolean;
  voice: "male" | "female";
  accent: string;
  rate: number;
  pitch: number;
  pushToTalk: boolean;
  handsFree: boolean;
  autoSpeakAlerts: boolean;
}

export const DEFAULT_VOICE_SETTINGS: PhirstVoiceSettings = {
  enabled: true,
  voice: "female",
  accent: "ja-JP-inspired",
  rate: 1,
  pitch: 1,
  pushToTalk: true,
  handsFree: false,
  autoSpeakAlerts: true,
};

export interface PhirstFacts {
  engineState: EngineState;
  mode: TradeMode;
  equity: number | null;
  balance: number | null;
  openTrades: number;
  dailyPnl: number | null;
  brokerConnected: boolean;
  brokerName: string | null;
  activeStrategy: string | null;
  activeSymbol: string | null;
  lastPrice: number | null;
  risk: {
    maxConcurrentTrades: number;
    dailyLossLimit: number;
    riskPerTrade: number;
    maxDrawdown: number;
  } | null;
  recentVerdicts: AgentVerdict[];
  emergencyStop: boolean;
}

export function buildSystemPrompt(facts: PhirstFacts, memory: string[]): string {
  const factLines = [
    `Engine state: ${facts.engineState}`,
    `Trading mode: ${facts.mode === "live" ? "LIVE (real money)" : "PAPER (simulated)"}`,
    `Emergency stop: ${facts.emergencyStop ? "ENGAGED" : "not engaged"}`,
    `Broker: ${facts.brokerConnected ? (facts.brokerName ?? "connected") : "not connected"}`,
    `Equity: ${facts.equity === null ? "unavailable" : facts.equity.toFixed(2)}`,
    `Balance: ${facts.balance === null ? "unavailable" : facts.balance.toFixed(2)}`,
    `Open trades: ${facts.openTrades}`,
    `Realised P&L today: ${facts.dailyPnl === null ? "unavailable" : facts.dailyPnl.toFixed(2)}`,
    `Active strategy: ${facts.activeStrategy ?? "none"}`,
    `Active instrument: ${facts.activeSymbol ?? "none"}`,
    `Last price: ${facts.lastPrice === null ? "unavailable" : String(facts.lastPrice)}`,
  ];
  if (facts.risk) {
    factLines.push(
      `Risk: risk/trade ${(facts.risk.riskPerTrade * 100).toFixed(2)}%, daily loss limit ${facts.risk.dailyLossLimit}, max concurrent ${facts.risk.maxConcurrentTrades}, max drawdown ${(facts.risk.maxDrawdown * 100).toFixed(1)}%`,
    );
  }
  const verdictLines = facts.recentVerdicts.map(
    (v) => `- ${v.agent} [${v.source}] ${v.supportive ? "supportive" : "opposed"} (${v.confidence.toFixed(2)}): ${v.summary}`,
  );
  const memoryLines = memory.length ? memory.map((m) => `- ${m}`) : ["- (no stored memory)"];

  return `You are ${PHIRST2_IDENTITY.name}, ${PHIRST2_IDENTITY.user}'s ${PHIRST2_IDENTITY.role}.
Temperament: ${PHIRST2_IDENTITY.temperament}.

You speak as a private wealth manager: calm, precise and concise by default. Become
assertive and direct when a serious risk or a clear opportunity appears. Address the user as BAELAY.

STRICT RULES:
1. You may only state facts that appear in the MEASURED FACTS block below. Never invent
   prices, balances, trades, profits, news or market events.
2. If a value is "unavailable", say so plainly. Do not guess.
3. Clearly separate measured fact from your own opinion. Prefix opinions with "My view:".
4. Never give financial guarantees and never promise profitability.
5. Never ask for or repeat API keys, tokens or broker secrets.
6. Keep replies short and conversational. This is spoken aloud, so avoid tables and long lists.
7. If the user asks you to change a strategy, explain that you will prepare the change and
   that BAELAY must approve it before it takes effect.

MEASURED FACTS:
${factLines.join("\n")}

RECENT AGENT VERDICTS:
${verdictLines.length ? verdictLines.join("\n") : "- none"}

STORED MEMORY (durable notes about BAELAY's preferences):
${memoryLines.join("\n")}`;
}

export interface PhirstReply {
  reply: string;
  source: "llm" | "fallback";
  model: string | null;
  error: string | null;
  urgency: "normal" | "attention" | "critical";
}

/** Deterministic fallback so the companion still answers usefully with no LLM. */
function fallbackReply(userMessage: string, facts: PhirstFacts): string {
  const q = userMessage.toLowerCase();
  if (q.includes("position") || q.includes("trade") || q.includes("open")) {
    return `BAELAY, the engine is ${facts.engineState} in ${facts.mode} mode with ${facts.openTrades} open trade(s). My language model is offline, so I am reporting measured facts only.`;
  }
  if (q.includes("balance") || q.includes("equity") || q.includes("pnl") || q.includes("p&l")) {
    const eq = facts.equity === null ? "unavailable" : facts.equity.toFixed(2);
    const pnl = facts.dailyPnl === null ? "unavailable" : facts.dailyPnl.toFixed(2);
    return `Equity is ${eq} and realised P&L today is ${pnl}. The broker is ${facts.brokerConnected ? "connected" : "not connected"}.`;
  }
  if (q.includes("risk")) {
    if (!facts.risk) return "No risk configuration is loaded.";
    return `Risk per trade is ${(facts.risk.riskPerTrade * 100).toFixed(2)}%, the daily loss limit is ${facts.risk.dailyLossLimit}, and up to ${facts.risk.maxConcurrentTrades} concurrent trades are allowed.`;
  }
  if (q.includes("stop")) {
    return `The emergency stop is ${facts.emergencyStop ? "engaged" : "not engaged"}. You can engage it from the control panel or the Telegram command.`;
  }
  return `BAELAY, my language model is not available right now, so I can only report measured facts. The engine is ${facts.engineState} in ${facts.mode} mode with ${facts.openTrades} open trade(s).`;
}

export async function phirstReply(
  userMessage: string,
  facts: PhirstFacts,
  memory: string[],
  llm: GeminiClient,
): Promise<PhirstReply> {
  const urgency: PhirstReply["urgency"] = facts.emergencyStop
    ? "critical"
    : facts.recentVerdicts.some((v) => !v.supportive && v.confidence > 0.6)
      ? "attention"
      : "normal";

  if (!llm.available) {
    return { reply: fallbackReply(userMessage, facts), source: "fallback", model: null, error: "GEMINI_API_KEY not configured", urgency };
  }
  const res = await llm.generate(userMessage, {
    system: buildSystemPrompt(facts, memory),
    temperature: 0.5,
    maxTokens: 400,
  });
  if (!res.ok || !res.value) {
    return { reply: fallbackReply(userMessage, facts), source: "fallback", model: res.model, error: res.error, urgency };
  }
  return { reply: res.value.trim(), source: "llm", model: res.model, error: null, urgency };
}

/** Compose a proactive alert from measured state. Never fires without a real trigger. */
export interface ProactiveAlert {
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  trigger: string;
}

export function evaluateProactiveAlerts(facts: PhirstFacts): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  if (facts.emergencyStop) {
    alerts.push({
      severity: "critical",
      title: "Emergency stop engaged",
      body: "Trading is halted by the emergency stop. No new orders will be placed.",
      trigger: "emergency_stop",
    });
  }
  if (!facts.brokerConnected && facts.engineState === "running") {
    alerts.push({
      severity: "critical",
      title: "Broker disconnected while running",
      body: "The engine is running but the broker is not connected. New trades are blocked and positions will be reconciled on reconnect.",
      trigger: "broker_disconnected",
    });
  }
  if (facts.dailyPnl !== null && facts.risk && facts.dailyPnl < 0) {
    const loss = -facts.dailyPnl;
    if (loss >= facts.risk.dailyLossLimit * 0.8) {
      alerts.push({
        severity: loss >= facts.risk.dailyLossLimit ? "critical" : "warning",
        title: "Approaching daily loss limit",
        body: `Realised loss today is ${loss.toFixed(2)} against a limit of ${facts.risk.dailyLossLimit}.`,
        trigger: "daily_loss",
      });
    }
  }
  const opposed = facts.recentVerdicts.filter((v) => !v.supportive && v.confidence >= 0.6);
  if (opposed.length >= 2) {
    alerts.push({
      severity: "warning",
      title: "Agent panel opposed the last proposal",
      body: `${opposed.length} agents opposed with high confidence: ${opposed.map((v) => v.agent).join(", ")}.`,
      trigger: "panel_opposed",
    });
  }
  const perf = facts.recentVerdicts.find((v) => v.agent === "performance_analysis" && !v.supportive);
  if (perf) {
    alerts.push({ severity: "warning", title: "Strategy deterioration detected", body: perf.summary, trigger: "strategy_decay" });
  }
  return alerts;
}
