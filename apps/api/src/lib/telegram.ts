import {
  getTelegramLink,
  upsertTelegramLink,
  consumeTelegramLinkCode,
  listTelegramLinks,
  deleteTelegramLink,
  audit,
  type Config,
  type Logger,
  type NotificationInput,
} from "@phirst/core";
import type { TradingEngine } from "@phirst/engine";

export type TelegramPermission = "read" | "control" | "trade" | "emergency";

const ALL_PERMISSIONS: TelegramPermission[] = ["read", "control", "trade", "emergency"];

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

export interface TelegramStatus {
  configured: boolean;
  running: boolean;
  lastError: string | null;
  botUsername: string | null;
  updatesProcessed: number;
}

/**
 * Telegram integration.
 *
 * Security model:
 *  - A chat must be explicitly linked to a user via a short-lived code generated in the
 *    web app while signed in. Unlinked chats are refused.
 *  - Each linked chat has an explicit permission list. Commands check the permission
 *    they need before running.
 *  - The bot token is read from the environment and never logged.
 *  - Update ids are tracked so a replayed update cannot re-run a command.
 */
export class TelegramBot {
  private running = false;
  private offset = 0;
  private lastError: string | null = null;
  private botUsername: string | null = null;
  private updatesProcessed = 0;
  private seenUpdates = new Set<number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: Config,
    private engine: TradingEngine,
    private log: Logger,
    private recordUpdate: (updateId: number) => Promise<boolean>,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.telegramBotToken);
  }

  status(): TelegramStatus {
    return {
      configured: this.configured,
      running: this.running,
      lastError: this.lastError,
      botUsername: this.botUsername,
      updatesProcessed: this.updatesProcessed,
    };
  }

  private async api(method: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const token = this.config.telegramBotToken;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || body.ok !== true) {
      throw new Error(`Telegram ${method} failed: ${JSON.stringify(body.description ?? body)}`);
    }
    return body.result as Record<string, unknown>;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.configured) return;
    try {
      await this.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn("telegram send failed", { error: (err as Error).message });
    }
  }

  async start(): Promise<void> {
    if (!this.configured) {
      this.log.info("telegram not configured; bot disabled");
      return;
    }
    try {
      const me = await this.api("getMe");
      this.botUsername = String(me.username ?? "");
      this.running = true;
      this.log.info("telegram bot started", { username: this.botUsername });
      this.poll();
    } catch (err) {
      this.running = false;
      this.lastError = (err as Error).message;
      this.log.error("telegram start failed", { error: (err as Error).message });
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.poll());
    }, 1500);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const updates = (await this.api("getUpdates", {
        offset: this.offset,
        timeout: 10,
        allowed_updates: ["message"],
      })) as unknown as TelegramUpdate[];
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        // Replay protection: refuse an update id already processed.
        const isNew = await this.recordUpdate(update.update_id);
        if (!isNew || this.seenUpdates.has(update.update_id)) continue;
        this.seenUpdates.add(update.update_id);
        await this.handleUpdate(update);
        this.updatesProcessed++;
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn("telegram poll failed", { error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text || !msg.chat) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const from = msg.from?.username ? `@${msg.from.username}` : String(msg.from?.id ?? "unknown");

    // /start with a link code completes the link and grants read + control.
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      if (!code) {
        await this.sendMessage(chatId, "PHIRST2 is online. To link this chat, generate a link code in the web app under Telegram and send /start &lt;code&gt;.");
        return;
      }
      const userId = await consumeTelegramLinkCode(code);
      if (!userId) {
        await this.sendMessage(chatId, "That link code is invalid or has expired. Generate a new one in the web app.");
        await audit({ actor: from, action: "telegram.link_failed", detail: { chatId } });
        return;
      }
      // Default permissions exclude trade and emergency; the owner grants them in the web app.
      try {
        await upsertTelegramLink(chatId, userId, ["read", "control"]);
      } catch (err) {
        // Surface the real reason instead of leaving the chat stuck on "not linked".
        this.lastError = (err as Error).message;
        this.log.error("telegram link failed", { error: (err as Error).message, chatId });
        await audit({ actor: from, action: "telegram.link_failed", detail: { chatId, error: (err as Error).message } });
        await this.sendMessage(chatId, "Could not link this chat. The server rejected the link; check the API log.");
        return;
      }
      await audit({ actor: from, action: "telegram.linked", detail: { chatId } });
      await this.sendMessage(chatId, "Linked to PHIRST2. You can use /status, /positions, /pause, /resume, /stop and /help. Trading and emergency permissions must be granted in the web app.");
      return;
    }

    const link = await getTelegramLink(chatId);
    if (!link) {
      await this.sendMessage(chatId, "This chat is not linked. Generate a link code in the PHIRST2 web app and send /start &lt;code&gt;.");
      return;
    }
    const permissions = (link.permissions as string[]) ?? [];
    const has = (p: TelegramPermission) => permissions.includes(p);
    const [command] = text.split(/\s+/);

    const needs = (p: TelegramPermission): boolean => {
      if (!has(p)) {
        void this.sendMessage(chatId, `Permission denied: this chat does not have the "${p}" permission. Grant it in the web app under Telegram.`);
        return true;
      }
      return false;
    };

    switch (command) {
      case "/help":
        await this.sendMessage(
          chatId,
          [
            "PHIRST2 commands",
            "/status - engine state, equity, open trades",
            "/positions - open positions",
            "/balance - balance and realised P&L today",
            "/pause - pause the engine (control)",
            "/resume - resume the engine (control)",
            "/stop - stop the engine (control)",
            "/buy &lt;amount&gt; &lt;seconds&gt; - place a buy order (trade)",
            "/sell &lt;amount&gt; &lt;seconds&gt; - place a sell order (trade)",
            "/emergencystop - engage the emergency stop (emergency)",
            "",
            `Your permissions: ${permissions.join(", ") || "none"}`,
          ].join("\n"),
        );
        return;

      case "/status": {
        if (needs("read")) return;
        const snap = await this.engine.snapshot();
        await this.sendMessage(
          chatId,
          [
            `<b>Engine</b> ${snap.state} (${snap.mode})`,
            snap.reason ? `Reason: ${snap.reason}` : "",
            `Broker: ${snap.brokerConnected ? snap.brokerName ?? "connected" : "not connected"}`,
            `Equity: ${snap.equity.toFixed(2)}`,
            `Open trades: ${snap.openTrades}`,
            `Realised P&L today: ${snap.dailyPnl.toFixed(2)}`,
            `Instrument: ${snap.symbol}`,
          ].filter(Boolean).join("\n"),
        );
        return;
      }

      case "/balance": {
        if (needs("read")) return;
        const snap = await this.engine.snapshot();
        await this.sendMessage(chatId, `Balance ${snap.balance.toFixed(2)}, unrealised ${snap.unrealized.toFixed(2)}, realised today ${snap.dailyPnl.toFixed(2)}.`);
        return;
      }

      case "/positions": {
        if (needs("read")) return;
        const snap = await this.engine.snapshot();
        await this.sendMessage(chatId, snap.openTrades === 0 ? "No open trades." : `Open trades: ${snap.openTrades}. See the web app for details.`);
        return;
      }

      case "/pause": {
        if (needs("control")) return;
        const r = await this.engine.pause("Paused via Telegram.");
        await audit({ actor: from, action: "telegram.pause", detail: { chatId, ok: r.ok } });
        await this.sendMessage(chatId, r.message);
        return;
      }

      case "/resume": {
        if (needs("control")) return;
        const r = await this.engine.resume();
        await audit({ actor: from, action: "telegram.resume", detail: { chatId, ok: r.ok } });
        await this.sendMessage(chatId, r.message);
        return;
      }

      case "/stop": {
        if (needs("control")) return;
        const r = await this.engine.stop("Stopped via Telegram.");
        await audit({ actor: from, action: "telegram.stop", detail: { chatId, ok: r.ok } });
        await this.sendMessage(chatId, r.message);
        return;
      }

      case "/emergencystop":
        if (needs("emergency")) return;
        await this.engine.emergencyStop("Emergency stop via Telegram.");
        await audit({ actor: from, action: "telegram.emergency_stop", detail: { chatId } });
        await this.sendMessage(chatId, "EMERGENCY STOP engaged. No new orders will be placed.");
        return;

      case "/buy":
      case "/sell": {
        if (needs("trade")) return;
        const parts = text.split(/\s+/);
        const amount = Number(parts[1]);
        const durationSec = Number(parts[2]);
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(durationSec) || durationSec <= 0) {
          await this.sendMessage(chatId, `Usage: ${command} &lt;amount&gt; &lt;durationSeconds&gt;`);
          return;
        }
        const result = await this.engine.manualOrder({
          side: command === "/buy" ? "buy" : "sell",
          amount,
          durationSec,
          origin: "telegram",
        });
        await audit({ actor: from, action: `telegram.${command.slice(1)}`, detail: { chatId, amount, durationSec, ok: result.ok }, });
        await this.sendMessage(chatId, result.ok ? `${command.slice(1).toUpperCase()} order placed: ${result.message}` : `Order not placed: ${result.message}`);
        return;
      }

      default:
        await this.sendMessage(chatId, "Unknown command. Send /help for the command list.");
    }
  }

  /** Broadcast a notification to every linked chat that has read permission. */
  async broadcast(title: string, body: string): Promise<void> {
    if (!this.configured) return;
    const links = await listTelegramLinks();
    for (const link of links) {
      const permissions = (link.permissions as string[]) ?? [];
      if (!permissions.includes("read")) continue;
      await this.sendMessage(String(link.chat_id), `<b>${title}</b>\n${body}`);
    }
  }

  /**
   * Deliver a persisted engine notification to Telegram. Only events that matter to the
   * owner are forwarded: critical and warning severities, and PHIRST2's own proactive
   * alerts. Routine info rows stay in the web app so the chat is not noisy. The owner's
   * allow-listed chat id is always included even before a link is completed, so a risk
   * event cannot go unseen.
   */
  async notifyChannel(n: NotificationInput): Promise<void> {
    if (!this.configured) return;
    if (!shouldForwardToTelegram(n)) return;

    const text = formatTelegramAlert(n);
    const recipients = new Set<string>(this.config.telegramAllowedChatIds);
    for (const link of await listTelegramLinks()) {
      const permissions = (link.permissions as string[]) ?? [];
      if (permissions.includes("read")) recipients.add(String(link.chat_id));
    }
    for (const chatId of recipients) await this.sendMessage(chatId, text);
  }
}

/**
 * Whether a notification is important enough to interrupt the owner on Telegram. Routine
 * info rows are left in the web app so the chat stays signal, not noise.
 */
export function shouldForwardToTelegram(n: { severity: string; category: string }): boolean {
  return n.severity === "critical" || n.severity === "warning" || n.severity === "warn" || n.category === "phirst2";
}

/** Format a notification for Telegram HTML parse mode, escaping the dynamic text. */
export function formatTelegramAlert(n: { severity: string; title: string; body: string }): string {
  const prefix = n.severity === "critical" ? "🔴" : n.severity === "warning" || n.severity === "warn" ? "🟠" : "ℹ️";
  return `${prefix} <b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}`;
}

/** Telegram HTML parse mode requires these three characters escaped in dynamic text. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { ALL_PERMISSIONS };
export type { TelegramPermission as Permission };
