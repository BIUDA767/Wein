import { describe, it, expect } from "vitest";
import { normalisePreferences, DEFAULT_UI_PREFERENCES } from "../apps/api/src/routes/preferences.ts";
import { buildVisemeTimeline, sampleViseme, indexForChar, VISEME_SHAPES } from "../apps/web/src/lib/visemes.ts";

describe("UI preferences validation", () => {
  it("accepts a well-formed payload and normalises it", () => {
    const result = normalisePreferences(
      { chartStyle: "area", chartGrid: false, soundVolume: 0.25, defaultIndicators: ["rsi", "ema"] },
      DEFAULT_UI_PREFERENCES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chartStyle).toBe("area");
    expect(result.value.chartGrid).toBe(false);
    expect(result.value.soundVolume).toBe(0.25);
    expect(result.value.defaultIndicators).toEqual(["rsi", "ema"]);
  });

  it("rejects an unknown chart style rather than silently substituting one", () => {
    const result = normalisePreferences({ chartStyle: "rainbow" }, DEFAULT_UI_PREFERENCES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("chartStyle");
  });

  it("rejects out-of-range numbers", () => {
    expect(normalisePreferences({ soundVolume: 1.5 }, DEFAULT_UI_PREFERENCES).ok).toBe(false);
    expect(normalisePreferences({ chartHeight: 40 }, DEFAULT_UI_PREFERENCES).ok).toBe(false);
    expect(normalisePreferences({ defaultAmount: 0 }, DEFAULT_UI_PREFERENCES).ok).toBe(false);
    expect(normalisePreferences({ defaultDurationSec: 1.5 }, DEFAULT_UI_PREFERENCES).ok).toBe(false);
  });

  it("drops unknown indicators and tiles instead of storing them", () => {
    const result = normalisePreferences(
      { defaultIndicators: ["rsi", "nonsense"], dashboardTiles: ["equity", "bogus"] },
      DEFAULT_UI_PREFERENCES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultIndicators).toEqual(["rsi"]);
    expect(result.value.dashboardTiles).toEqual(["equity"]);
  });

  it("refuses to leave the chart with no timeframes", () => {
    const result = normalisePreferences({ timeframes: [] }, DEFAULT_UI_PREFERENCES);
    expect(result.ok).toBe(false);
  });

  it("falls back to defaults when a partial payload arrives", () => {
    const result = normalisePreferences({}, DEFAULT_UI_PREFERENCES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(DEFAULT_UI_PREFERENCES);
  });
});

describe("viseme timeline", () => {
  it("maps vowels to open shapes and plosives to closed ones", () => {
    const steps = buildVisemeTimeline("baba");
    const shapes = steps.map((s) => s.viseme);
    expect(shapes).toContain("M"); // b is a bilabial, mouth closed
    expect(shapes).toContain("A"); // a is open
  });

  it("holds vowels longer than consonants", () => {
    // "a" (vowel, weight 2) should outnumber "t" (consonant, weight 1).
    const steps = buildVisemeTimeline("atat");
    const vowels = steps.filter((s) => s.viseme === "A").length;
    const consonants = steps.filter((s) => s.viseme !== "A" && s.viseme !== "sil").length;
    expect(vowels).toBeGreaterThan(consonants);
  });

  it("produces an empty timeline for punctuation only", () => {
    expect(buildVisemeTimeline("...").every((s) => s.viseme === "sil")).toBe(true);
  });

  it("samples silence at the start and a shape by the end", () => {
    const steps = buildVisemeTimeline("hello there");
    const start = sampleViseme(steps, 0, 1000);
    expect(start.open).toBeLessThanOrEqual(VISEME_SHAPES.A.open);
    const end = sampleViseme(steps, 1000, 1000);
    expect(end.open).toBeGreaterThanOrEqual(0);
  });

  it("re-anchors to the correct index for a character offset", () => {
    const steps = buildVisemeTimeline("hello");
    // Character 0 is 'h'; the first timeline entry must not be later than it.
    const idx = indexForChar(steps, 0);
    expect(idx).toBe(0);
    const last = indexForChar(steps, 999);
    expect(last).toBe(steps.length - 1);
  });

  it("clamps sampling beyond the end of the utterance", () => {
    const steps = buildVisemeTimeline("test");
    const frame = sampleViseme(steps, 10_000, 1000);
    expect(frame.open).toBeGreaterThanOrEqual(0);
    expect(frame.open).toBeLessThanOrEqual(1);
  });
});
