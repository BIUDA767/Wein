import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { type NotificationInput } from "@phirst/core";
import { shouldForwardToTelegram, formatTelegramAlert } from "../apps/api/src/lib/telegram.ts";

describe("Telegram alert fan-out", () => {
  it("forwards critical and warning events, not routine info", () => {
    expect(shouldForwardToTelegram({ severity: "critical", category: "risk" })).toBe(true);
    expect(shouldForwardToTelegram({ severity: "warning", category: "execution" })).toBe(true);
    expect(shouldForwardToTelegram({ severity: "warn", category: "execution" })).toBe(true);
    // Routine info is left in the web app so the chat stays signal, not noise.
    expect(shouldForwardToTelegram({ severity: "info", category: "telegram" })).toBe(false);
  });

  it("always forwards PHIRST2 proactive alerts even at info severity", () => {
    expect(shouldForwardToTelegram({ severity: "info", category: "phirst2" })).toBe(true);
  });

  it("escapes HTML in dynamic text so a crafted title cannot break parse mode", () => {
    const out = formatTelegramAlert({
      severity: "critical",
      title: "Order <b>rejected</b>",
      body: "Amount < 5 & symbol > 100",
    });
    expect(out).toContain("🔴");
    expect(out).toContain("&lt;b&gt;rejected&lt;/b&gt;");
    expect(out).toContain("&lt; 5 &amp;");
    expect(out).not.toContain("<b>rejected</b>");
  });

  it("tags warning events distinctly from critical", () => {
    expect(formatTelegramAlert({ severity: "warning", title: "t", body: "b" })).toContain("🟠");
    expect(formatTelegramAlert({ severity: "info", title: "t", body: "b" })).toContain("ℹ️");
  });
});

// The sink is the engine's single delivery choke point, so it is verified against a real
// database rather than a stub. Skipped when TEST_DATABASE_URL is absent, which is the
// honest "no database here" skip, not a silent pass.
const dsn = process.env.TEST_DATABASE_URL;
const maybe = dsn ? describe : describe.skip;

maybe("notification sink fan-out (database)", () => {
  let core: typeof import("@phirst/core");
  const received: NotificationInput[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = dsn;
    core = await import("@phirst/core");
    await core.getPool().query("SELECT 1");
  });

  afterAll(async () => {
    core.setNotificationSink(null);
    await core.closePool().catch(() => {});
  });

  beforeEach(() => {
    received.length = 0;
    core.setNotificationSink((n) => {
      received.push(n);
    });
  });

  it("hands every persisted notification to the registered sink with its full payload", async () => {
    await core.insertNotification({
      severity: "critical",
      title: "Emergency stop engaged",
      body: "test",
      category: "risk",
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ severity: "critical", title: "Emergency stop engaged", category: "risk" });
  });

  it("survives a throwing sink without losing the notification", async () => {
    core.setNotificationSink(() => {
      throw new Error("channel down");
    });
    const id = await core.insertNotification({ severity: "warning", title: "still stored", body: "b", category: "execution" });
    expect(id).toBeTruthy();
    const rows = await core.listNotifications(5);
    expect(rows.some((r) => r.title === "still stored")).toBe(true);
  });
});
