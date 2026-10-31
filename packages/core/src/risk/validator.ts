import type { AgentVerdict, RiskDecision, TradeIntent } from "../types.ts";

/**
 * The independent trade validator.
 *
 * It sits alongside PHIRST2 and the risk engine and asks a different question: not
 * "is this trade allowed?" (the risk engine decides that) but "is this trade sound?".
 * It is deliberately pure and synchronous — no I/O, no LLM — so it adds no latency to
 * a time-sensitive decision and cannot be skipped when a model is unreachable.
 *
 * Outcomes:
 *   allow     proceed
 *   escalate  proceed only with the owner's awareness; in autonomous mode the trade
 *             is parked for approval rather than executed silently
 *   block     do not proceed
 */

export type ValidationOutcome = "allow" | "escalate" | "block";

export interface ValidationCheck {
  id: string;
  label: string;
  outcome: ValidationOutcome;
  detail: string;
}

export interface ValidationResult {
  outcome: ValidationOutcome;
  checks: ValidationCheck[];
  /** Short human-readable reasons, most severe first. */
  reasons: string[];
}

export interface ValidationInput {
  intent: TradeIntent;
  risk: RiskDecision;
  verdicts: AgentVerdict[];
  /** Current market spread as a fraction of price (0.001 = 0.1%). Null when unknown. */
  spreadFraction: number | null;
  /** Orders placed in the last hour, for abnormal-activity detection. */
  ordersLastHour: number;
  /** Seconds since the most recent settled loss, or null when there is none. */
  secondsSinceLastLoss: number | null;
  /** Consecutive losses, most recent first. */
  consecutiveLosses: number;
  /** The broker's minimum expiry in seconds, or null when it publishes none. */
  minExpirySec: number | null;
  /** Configured limits used for the abnormal-activity thresholds. */
  limits: { maxOrdersPerHour: number; minSecondsBetweenLossAndReentry: number; maxSpreadFraction: number };
}

export const DEFAULT_VALIDATION_LIMITS = {
  maxOrdersPerHour: 30,
  minSecondsBetweenLossAndReentry: 60,
  maxSpreadFraction: 0.002,
};

const worst = (a: ValidationOutcome, b: ValidationOutcome): ValidationOutcome => {
  const rank: Record<ValidationOutcome, number> = { allow: 0, escalate: 1, block: 2 };
  return rank[a] >= rank[b] ? a : b;
};

export function validateTrade(input: ValidationInput): ValidationResult {
  const checks: ValidationCheck[] = [];
  const add = (id: string, label: string, outcome: ValidationOutcome, detail: string) =>
    checks.push({ id, label, outcome, detail });

  // 1. Risk compliance. If the risk engine did not approve, nothing else matters.
  add(
    "risk",
    "Risk engine approval",
    input.risk.approved ? "allow" : "block",
    input.risk.approved
      ? `Approved at ${input.risk.approvedAmount.toFixed(2)}${input.risk.adjustments.length ? ` (${input.risk.adjustments.join("; ")})` : ""}.`
      : input.risk.reasons.join(" "),
  );

  // 2. Execution cost. A spread wider than the ceiling makes a marginal edge negative.
  if (input.spreadFraction === null) {
    add("spread", "Execution cost", "allow", "Spread is not published by the active broker; not assessed.");
  } else if (input.spreadFraction > input.limits.maxSpreadFraction) {
    add(
      "spread",
      "Execution cost",
      "escalate",
      `Spread ${(input.spreadFraction * 100).toFixed(3)}% exceeds the ${(input.limits.maxSpreadFraction * 100).toFixed(3)}% ceiling.`,
    );
  } else {
    add("spread", "Execution cost", "allow", `Spread ${(input.spreadFraction * 100).toFixed(3)}% is within tolerance.`);
  }

  // 3. Contract duration must be one the broker can honour.
  if (input.minExpirySec !== null && (input.intent.durationSec ?? 0) < input.minExpirySec) {
    add(
      "duration",
      "Contract duration",
      "block",
      `Requested ${input.intent.durationSec}s is below the broker minimum of ${input.minExpirySec}s.`,
    );
  } else {
    add("duration", "Contract duration", "allow", `Duration ${input.intent.durationSec ?? "default"}s is supported.`);
  }

  // 4. Conflicting signals. Opposed high-confidence agents are a genuine warning; a
  //    single dissenting voice is not. Count only the agents that carry weight.
  const opposing = input.verdicts.filter((v) => !v.supportive && v.confidence >= 0.6);
  if (opposing.length >= 2) {
    add("conflict", "Signal agreement", "block", `${opposing.length} high-confidence agents oppose: ${opposing.map((v) => v.agent).join(", ")}.`);
  } else if (opposing.length === 1) {
    add("conflict", "Signal agreement", "escalate", `One high-confidence agent opposes: ${opposing[0]!.agent}.`);
  } else {
    add("conflict", "Signal agreement", "allow", "No high-confidence opposition.");
  }

  // 5. Abnormal activity. Overtrading is a behaviour problem, not a market one.
  if (input.ordersLastHour >= input.limits.maxOrdersPerHour) {
    add(
      "activity",
      "Trading frequency",
      "block",
      `${input.ordersLastHour} orders in the last hour reaches the ${input.limits.maxOrdersPerHour}/hour ceiling.`,
    );
  } else if (input.ordersLastHour >= input.limits.maxOrdersPerHour * 0.8) {
    add("activity", "Trading frequency", "escalate", `${input.ordersLastHour} orders in the last hour is approaching the ceiling.`);
  } else {
    add("activity", "Trading frequency", "allow", `${input.ordersLastHour} orders in the last hour.`);
  }

  // 6. Revenge-trading guard. Re-entering immediately after a loss is the classic
  //    pattern this exists to interrupt. It can never increase size (no martingale).
  if (
    input.secondsSinceLastLoss !== null &&
    input.secondsSinceLastLoss < input.limits.minSecondsBetweenLossAndReentry
  ) {
    add(
      "revenge",
      "Post-loss re-entry",
      "escalate",
      `Re-entry ${Math.round(input.secondsSinceLastLoss)}s after a loss, under the ${input.limits.minSecondsBetweenLossAndReentry}s cooldown.`,
    );
  } else {
    add("revenge", "Post-loss re-entry", "allow", "No post-loss re-entry concern.");
  }

  // 7. Strategy deviation. An intent that names no strategy is manual and exempt.
  if (input.intent.strategyId && input.intent.origin === "engine") {
    const strategyVerdict = input.verdicts.find((v) => v.agent === "strategy_management");
    if (strategyVerdict && !strategyVerdict.supportive) {
      add("strategy", "Strategy alignment", "escalate", strategyVerdict.summary);
    } else {
      add("strategy", "Strategy alignment", "allow", "Intent matches the active strategy.");
    }
  } else {
    add("strategy", "Strategy alignment", "allow", "No strategy-bound intent to check.");
  }

  let outcome: ValidationOutcome = "allow";
  for (const c of checks) outcome = worst(outcome, c.outcome);

  const order: Record<ValidationOutcome, number> = { block: 0, escalate: 1, allow: 2 };
  const reasons = checks
    .filter((c) => c.outcome !== "allow")
    .sort((a, b) => order[a.outcome] - order[b.outcome])
    .map((c) => `${c.label}: ${c.detail}`);

  return { outcome, checks, reasons };
}
