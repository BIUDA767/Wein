/**
 * PHIRST2 automated moderation.
 *
 * Deliberately deterministic and local: it must never depend on an LLM being reachable,
 * because a moderation decision cannot be skipped when the model is down. It detects the
 * categories the brief names - spam, scams, harassment and harmful content - and returns
 * a recommended action with the evidence that triggered it.
 *
 * The screener only ever recommends. The caller records the action in
 * `moderation_actions`, so every automated decision is auditable and reversible by a
 * human administrator.
 */

export type ModerationCategory = "spam" | "scam" | "harassment" | "harmful" | "solicitation" | "none";
export type RecommendedAction = "warn" | "hide" | "suspend" | "ban";

export interface ModerationVerdict {
  blocked: boolean;
  category: ModerationCategory;
  action: RecommendedAction;
  reason: string;
  /** The specific matched phrases, so a human reviewer can judge the call. */
  evidence: { matched: string[]; score: number };
}

interface Rule {
  category: ModerationCategory;
  action: RecommendedAction;
  patterns: RegExp[];
  reason: string;
  block: boolean;
}

const RULES: Rule[] = [
  {
    category: "scam",
    action: "ban",
    block: true,
    reason: "This looks like a scam attempt: it asks for money, keys or credentials.",
    patterns: [
      /\b(send|transfer|deposit)\b[^.]{0,40}\b(btc|bitcoin|usdt|eth|ethereum|wallet)\b/i,
      /\b(seed phrase|private key|recovery phrase|12[- ]word)\b/i,
      /\bguaranteed (profit|returns?|wins?)\b/i,
      /\b(double|triple) your (money|investment|deposit)\b/i,
      /\b(risk[- ]free|no[- ]loss)\b[^.]{0,20}\b(guarantee|strategy|signal)/i,
      /\bclick (this|the) link\b[^.]{0,30}\b(claim|withdraw|bonus)\b/i,
    ],
  },
  {
    category: "solicitation",
    action: "hide",
    block: true,
    reason: "Soliciting members to move money or share account access is not allowed.",
    patterns: [
      /\b(dm|pm|whatsapp|telegram) me\b[^.]{0,40}\b(invest|fund|signal|profit)\b/i,
      /\bgive me (your )?(password|login|token|api key)\b/i,
      /\bshare your (credentials|password|api key)\b/i,
      /\baccount (manager|management)\b[^.]{0,30}\b(fee|cut|percentage)\b/i,
    ],
  },
  {
    category: "harassment",
    action: "suspend",
    block: true,
    reason: "This contains harassment or a targeted personal attack.",
    patterns: [
      /\b(kill|hurt|harm) yourself\b/i,
      /\byou (are|r) (a )?(idiot|moron|retard|loser|scum)\b/i,
      /\b(shut up|nobody cares about you)\b/i,
      /\b(doxx?|doxxing)\b/i,
    ],
  },
  {
    category: "spam",
    action: "hide",
    block: true,
    reason: "This looks like spam or repetitive promotion.",
    patterns: [
      /\b(free money|free crypto|airdrop claim|presale now)\b/i,
      /\b(join|click)\b[^.]{0,30}\b(https?:\/\/|www\.)\S+/i,
    ],
  },
  {
    category: "harmful",
    action: "hide",
    block: false,
    reason: "This may be harmful or misleading financial advice.",
    patterns: [/\b(all in|all-in|yolo)\b[^.]{0,20}\b(everything|savings|rent)\b/i, /\bcan'?t lose\b/i],
  },
];

/** Repetition, shouting and link-stuffing are spam signals. */
function spamShapeScore(text: string): number {
  let score = 0;
  if (/(.)\1{7,}/.test(text)) score += 1;
  if ((text.match(/!/g)?.length ?? 0) >= 6) score += 1;
  if ((text.match(/https?:\/\//g)?.length ?? 0) >= 3) score += 1;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length > 20 && (text.match(/[A-Z]/g)?.length ?? 0) / letters.length > 0.7) score += 1;
  return score;
}

function actionRank(a: RecommendedAction): number {
  return { warn: 0, hide: 1, suspend: 2, ban: 3 }[a];
}

/**
 * Screen a piece of user content. `options.authorId` is accepted so a future version can
 * add per-author history; no such history is fabricated here.
 */
export function screenContent(text: string, options: { authorId?: string } = {}): ModerationVerdict {
  void options;
  const matched: string[] = [];
  let worst: Rule | null = null;

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matched.push(m[0].trim());
        if (!worst || actionRank(rule.action) > actionRank(worst.action)) worst = rule;
      }
    }
  }

  const shapeScore = spamShapeScore(text);
  if (shapeScore >= 2 && (!worst || actionRank("hide") > actionRank(worst.action))) {
    worst = {
      category: "spam",
      action: "hide",
      block: true,
      reason: "This looks like spam: excessive repetition, shouting or links.",
      patterns: [],
    };
    matched.push(`formatting score ${shapeScore}`);
  }

  if (!worst) {
    return { blocked: false, category: "none", action: "warn", reason: "No policy violation detected.", evidence: { matched: [], score: 0 } };
  }

  return {
    blocked: worst.block,
    category: worst.category,
    action: worst.action,
    reason: worst.reason,
    evidence: { matched, score: matched.length + shapeScore },
  };
}
