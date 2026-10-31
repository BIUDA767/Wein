import { describe, it, expect } from "vitest";
import {
  validateTrade,
  DEFAULT_VALIDATION_LIMITS,
  type ValidationInput,
  type AgentVerdict,
  type RiskDecision,
  type TradeIntent,
} from "@phirst/core";

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  symbol: "R_100",
  side: "buy",
  orderType: "fixed_expiry",
  amount: 100,
  durationSec: 60,
  origin: "engine",
  mode: "paper",
  ...over,
});

const approved = (over: Partial<RiskDecision> = {}): RiskDecision => ({
  approved: true,
  reasons: [],
  approvedAmount: 100,
  adjustments: [],
  ...over,
});

const verdict = (over: Partial<AgentVerdict> = {}): AgentVerdict => ({
  agent: "technical_analysis",
  supportive: true,
  confidence: 0.8,
  summary: "ok",
  source: "deterministic",
  at: new Date().toISOString(),
  ...over,
});

const input = (over: Partial<ValidationInput> = {}): ValidationInput => ({
  intent: intent(),
  risk: approved(),
  verdicts: [verdict()],
  spreadFraction: 0.0005,
  ordersLastHour: 3,
  secondsSinceLastLoss: null,
  consecutiveLosses: 0,
  minExpirySec: 5,
  limits: DEFAULT_VALIDATION_LIMITS,
  ...over,
});

describe("validateTrade", () => {
  it("allows a sound trade", () => {
    const r = validateTrade(input());
    expect(r.outcome).toBe("allow");
    expect(r.reasons).toEqual([]);
  });

  it("blocks when the risk engine did not approve", () => {
    const r = validateTrade(input({ risk: approved({ approved: false, approvedAmount: 0, reasons: ["daily loss limit reached"] }) }));
    expect(r.outcome).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/daily loss limit/);
  });

  it("blocks a duration below the broker minimum", () => {
    const r = validateTrade(input({ intent: intent({ durationSec: 5 }), minExpirySec: 15 }));
    expect(r.outcome).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/below the broker minimum/);
  });

  it("does not assess duration when the broker publishes no minimum", () => {
    const r = validateTrade(input({ intent: intent({ durationSec: 1 }), minExpirySec: null }));
    expect(r.outcome).toBe("allow");
  });

  it("escalates a wide spread rather than blocking it", () => {
    const r = validateTrade(input({ spreadFraction: 0.05 }));
    expect(r.outcome).toBe("escalate");
    expect(r.reasons.join(" ")).toMatch(/spread/i);
  });

  it("does not assess spread when the broker publishes none", () => {
    const r = validateTrade(input({ spreadFraction: null }));
    expect(r.outcome).toBe("allow");
  });

  it("blocks two high-confidence opposing agents", () => {
    const r = validateTrade(
      input({
        verdicts: [
          verdict({ agent: "sentiment_analysis", supportive: false, confidence: 0.9 }),
          verdict({ agent: "quantitative_analysis", supportive: false, confidence: 0.7 }),
        ],
      }),
    );
    expect(r.outcome).toBe("block");
  });

  it("escalates a single high-confidence dissenter", () => {
    const r = validateTrade(input({ verdicts: [verdict(), verdict({ agent: "sentiment_analysis", supportive: false, confidence: 0.8 })] }));
    expect(r.outcome).toBe("escalate");
  });

  it("ignores a low-confidence dissenter", () => {
    const r = validateTrade(input({ verdicts: [verdict(), verdict({ agent: "sentiment_analysis", supportive: false, confidence: 0.3 })] }));
    expect(r.outcome).toBe("allow");
  });

  it("blocks overtrading past the hourly ceiling", () => {
    const r = validateTrade(input({ ordersLastHour: DEFAULT_VALIDATION_LIMITS.maxOrdersPerHour }));
    expect(r.outcome).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/ceiling/);
  });

  it("escalates as the hourly ceiling approaches", () => {
    const r = validateTrade(input({ ordersLastHour: DEFAULT_VALIDATION_LIMITS.maxOrdersPerHour - 1 }));
    expect(r.outcome).toBe("escalate");
  });

  it("escalates an immediate post-loss re-entry", () => {
    const r = validateTrade(input({ secondsSinceLastLoss: 5, consecutiveLosses: 1 }));
    expect(r.outcome).toBe("escalate");
    expect(r.reasons.join(" ")).toMatch(/post-loss re-entry/i);
  });

  it("allows re-entry once the cooldown has passed", () => {
    const r = validateTrade(input({ secondsSinceLastLoss: DEFAULT_VALIDATION_LIMITS.minSecondsBetweenLossAndReentry + 1 }));
    expect(r.outcome).toBe("allow");
  });

  it("escalates when the strategy agent opposes an engine intent", () => {
    const r = validateTrade(
      input({
        intent: intent({ strategyId: "trend:ema" }),
        verdicts: [verdict({ agent: "strategy_management", supportive: false, confidence: 0.9 })],
      }),
    );
    expect(r.outcome).toBe("escalate");
    expect(r.reasons.join(" ")).toMatch(/Strategy alignment/);
  });

  it("does not apply strategy alignment to a manual intent", () => {
    // Low confidence, so the conflict check does not also fire; this isolates the
    // strategy-alignment dimension.
    const r = validateTrade(
      input({
        intent: intent({ strategyId: "trend:ema", origin: "manual" }),
        verdicts: [verdict({ agent: "strategy_management", supportive: false, confidence: 0.4 })],
      }),
    );
    expect(r.outcome).toBe("allow");
    expect(r.checks.find((c) => c.id === "strategy")?.detail).toMatch(/No strategy-bound intent/);
  });

  it("reports the worst outcome and orders reasons most-severe-first", () => {
    const r = validateTrade(
      input({
        risk: approved({ approved: false, reasons: ["halted"] }),
        spreadFraction: 0.05,
      }),
    );
    expect(r.outcome).toBe("block");
    // The block reason is listed before the escalation reason.
    expect(r.reasons[0]).toMatch(/Risk engine approval/);
  });

  it("always returns a check for every dimension it assessed", () => {
    const r = validateTrade(input());
    const ids = r.checks.map((c) => c.id);
    expect(ids).toContain("risk");
    expect(ids).toContain("spread");
    expect(ids).toContain("duration");
    expect(ids).toContain("conflict");
    expect(ids).toContain("activity");
    expect(ids).toContain("revenge");
    expect(ids).toContain("strategy");
  });
});
