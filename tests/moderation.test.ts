import { describe, it, expect } from "vitest";
import { screenContent } from "@phirst/ai";

describe("PHIRST2 moderation screener", () => {
  it("passes ordinary trading discussion", () => {
    const v = screenContent("Watching R_100 on the 15m. EMA cross looks constructive but RSI is overbought.");
    expect(v.blocked).toBe(false);
    expect(v.category).toBe("none");
  });

  it("blocks a scam asking for a wallet transfer", () => {
    const v = screenContent("Send 0.5 btc to my wallet and I will double your money");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("scam");
    expect(v.action).toBe("ban");
    expect(v.evidence.matched.length).toBeGreaterThan(0);
  });

  it("blocks a request for a seed phrase", () => {
    const v = screenContent("Share your seed phrase and I will recover the funds");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("scam");
  });

  it("blocks guaranteed-profit claims", () => {
    const v = screenContent("My bot gives guaranteed profit every single day");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("scam");
  });

  it("suspends on targeted harassment", () => {
    const v = screenContent("you are an idiot and nobody cares about you");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("harassment");
    expect(v.action).toBe("suspend");
  });

  it("flags credential solicitation", () => {
    const v = screenContent("give me your password so I can check your account");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("solicitation");
  });

  it("hides link-stuffed spam", () => {
    const v = screenContent("join now https://a.com https://b.com https://c.com https://d.com");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("spam");
  });

  it("detects shouting and repetition as spam", () => {
    const v = screenContent("THIS IS AMAZING!!!!!! BUYYYYYYYY NOW FRIENDS");
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("spam");
  });

  it("records the matched evidence for review", () => {
    const v = screenContent("guaranteed profit for everyone");
    expect(v.evidence.matched.some((m) => m.toLowerCase().includes("guaranteed"))).toBe(true);
  });
});
