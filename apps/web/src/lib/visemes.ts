"use client";

/**
 * Viseme timeline for lip synchronisation.
 *
 * Real synchronisation needs to know *which* sound is being made and *when*. The Web
 * Speech API gives us two usable signals: the `boundary` event, which fires at real word
 * boundaries with the character index the engine has reached, and the utterance's own
 * start/end. We convert the text to a viseme sequence, then walk it against a clock that
 * is re-anchored every time a boundary event arrives. The result follows the actual
 * speech rather than a decorative loop, and it self-corrects if the engine's pace drifts.
 *
 * This is the honest limit of the platform: browsers expose no raw audio for the
 * synthesised voice, so this is text-and-timing driven rather than spectral analysis.
 */

export type Viseme = "sil" | "A" | "I" | "U" | "E" | "O" | "M" | "F" | "L" | "W" | "C";

export interface VisemeFrame {
  shape: Viseme;
  /** Mouth openness, 0 (closed) to 1 (widest). */
  open: number;
  /** Lip spread, -1 (rounded/pursed) to 1 (wide). */
  spread: number;
}

export const VISEME_SHAPES: Record<Viseme, VisemeFrame> = {
  sil: { shape: "sil", open: 0.04, spread: 0 },
  A: { shape: "A", open: 0.86, spread: 0.35 },
  I: { shape: "I", open: 0.3, spread: 0.95 },
  U: { shape: "U", open: 0.3, spread: -0.8 },
  E: { shape: "E", open: 0.52, spread: 0.7 },
  O: { shape: "O", open: 0.72, spread: -0.7 },
  M: { shape: "M", open: 0.02, spread: -0.1 },
  F: { shape: "F", open: 0.16, spread: 0.2 },
  L: { shape: "L", open: 0.34, spread: 0.1 },
  W: { shape: "W", open: 0.26, spread: -0.6 },
  C: { shape: "C", open: 0.2, spread: 0.15 },
};

/** Map a single character to a viseme. Approximate, but consistent. */
function charViseme(ch: string): Viseme | null {
  const c = ch.toLowerCase();
  if (/\s/.test(c)) return "sil";
  if (/[.,!?;:—–-]/.test(c)) return "sil";
  if (/[mbp]/.test(c)) return "M";
  if (/[fv]/.test(c)) return "F";
  if (/[ou]/.test(c)) return "O";
  if (/[ae]/.test(c)) return "A";
  if (/i/.test(c)) return "I";
  if (/[ltnd]/.test(c)) return "L";
  if (/[wr]/.test(c)) return "W";
  if (/[szc]/.test(c)) return "C";
  if (/[y]/.test(c)) return "I";
  if (/[gk]/.test(c)) return "C";
  if (/[hjq]/.test(c)) return "A";
  if (/[a-z]/.test(c)) return "E";
  return null;
}

export interface VisemeStep {
  viseme: Viseme;
  /** Character offset in the source text, used to re-anchor against boundary events. */
  charIndex: number;
}

/**
 * Build the viseme timeline for a phrase. Vowels are held longer than consonants,
 * which is what makes the mouth look like it is speaking rather than flapping.
 */
export function buildVisemeTimeline(text: string): VisemeStep[] {
  const steps: VisemeStep[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const viseme = charViseme(ch);
    if (!viseme) continue;
    const isVowel = /[aeiou]/i.test(ch);
    const weight = isVowel ? 2 : 1;
    for (let k = 0; k < weight; k++) steps.push({ viseme, charIndex: i });
  }
  return steps;
}

/**
 * Advance the timeline against a clock.
 *
 * @param steps       the viseme timeline
 * @param elapsedMs   milliseconds since this utterance began
 * @param durationMs  expected total utterance length
 */
export function sampleViseme(steps: VisemeStep[], elapsedMs: number, durationMs: number): VisemeFrame {
  if (steps.length === 0) return VISEME_SHAPES.sil;
  const progress = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 0;
  const index = Math.min(steps.length - 1, Math.floor(progress * steps.length));
  const step = steps[index]!;
  const base = VISEME_SHAPES[step.viseme];
  // A gentle per-frame variation keeps the jaw from looking mechanical.
  const jitter = 1 + Math.sin(elapsedMs * 0.021) * 0.06;
  return { shape: base.shape, open: Math.min(1, base.open * jitter), spread: base.spread };
}

/** Find the timeline index for a character offset, used when re-anchoring. */
export function indexForChar(steps: VisemeStep[], charIndex: number): number {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.charIndex >= charIndex) return i;
  }
  return steps.length - 1;
}
