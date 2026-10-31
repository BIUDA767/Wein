/**
 * Integrations service: the single place that owns the external-service clients
 * (Resend, Supabase, Twelve Data) and the Gemini client that already existed.
 *
 * It exists so that:
 *  - credentials are read from configuration (the environment) exactly once;
 *  - the service-role key and the Resend key never leave the server;
 *  - every capability report reflects what the configured credentials genuinely enable;
 *  - email delivery is recorded so the platform never claims a send that did not happen.
 */
import {
  getSetting,
  setSetting,
  listEmailLog,
  logEmail,
  insertNotification,
  type Config,
  type Logger,
} from "@phirst/core";
import { ResendClient, securityAlertEmail, authEmail, testEmail } from "@phirst/email";
import { SupabaseClient } from "@phirst/supabase";
import { TwelveDataProvider } from "@phirst/marketdata";

export interface EmailDeliveryInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: "security" | "auth" | "system" | "test";
}

export class IntegrationsService {
  readonly resend: ResendClient;
  readonly supabase: SupabaseClient;
  readonly twelveData: TwelveDataProvider | null;

  constructor(private readonly config: Config, private readonly log: Logger) {
    this.resend = new ResendClient({
      apiKey: config.resendApiKey,
      from: config.resendFrom,
      replyTo: config.resendReplyTo,
      log,
    });
    this.supabase = new SupabaseClient({
      url: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      serviceRoleKey: config.supabaseServiceRoleKey,
      jwksUrl: config.supabaseJwksUrl,
      log,
    });
    this.twelveData = config.twelveDataApiKey
      ? new TwelveDataProvider({ apiKey: config.twelveDataApiKey, log })
      : null;
  }

  /** The owner's notification address, or null when unset. */
  async ownerEmail(): Promise<string | null> {
    return (await getSetting<string>("ownerEmail")) ?? null;
  }

  async setOwnerEmail(email: string | null): Promise<void> {
    await setSetting("ownerEmail", email);
  }

  /**
   * Send an email and record the outcome. Returns Resend's result verbatim so the caller
   * cannot report success that did not happen.
   */
  async send(input: EmailDeliveryInput): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    const result = await this.resend.send({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      tags: [{ name: "category", value: input.category }],
    });
    // Persist the attempt regardless of outcome, so delivery history is real.
    await logEmail({
      provider: "resend",
      toAddress: input.to,
      subject: input.subject,
      category: input.category,
      ok: result.ok,
      providerId: result.id,
      error: result.error,
    }).catch((err) => this.log.warn("failed to record email delivery", { error: (err as Error).message }));
    return result;
  }

  /** Send to the owner's configured address. No-op (with a clear reason) when unset. */
  async sendToOwner(input: Omit<EmailDeliveryInput, "to">): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    const to = await this.ownerEmail();
    if (!to) return { ok: false, id: null, error: "No owner email address is configured" };
    return this.send({ ...input, to });
  }

  /**
   * A security or system alert by email. Called for critical events; failures are logged
   * and never thrown into the trading path.
   */
  async alert(title: string, body: string, severity: string): Promise<void> {
    if (!this.resend.available) return;
    const tpl = securityAlertEmail({ title, body, severity });
    const res = await this.sendToOwner({ subject: tpl.subject, html: tpl.html, text: tpl.text, category: "security" });
    if (!res.ok) this.log.warn("security email not delivered", { title, error: res.error });
  }

  async authNotice(title: string, body: string): Promise<void> {
    if (!this.resend.available) return;
    const tpl = authEmail({ title, body });
    const res = await this.sendToOwner({ subject: tpl.subject, html: tpl.html, text: tpl.text, category: "auth" });
    if (!res.ok) this.log.warn("auth email not delivered", { title, error: res.error });
  }

  /** Verify the Resend sender domain and send a test message. */
  async testEmail(): Promise<{ ok: boolean; id: string | null; error: string | null; domains: Array<{ name: string; status: string }> }> {
    let domains: Array<{ name: string; status: string }> = [];
    try {
      domains = (await this.resend.listDomains()).map((d) => ({ name: d.name, status: d.status }));
    } catch (err) {
      this.log.warn("resend domain lookup failed", { error: (err as Error).message });
    }
    const to = await this.ownerEmail();
    if (!to) return { ok: false, id: null, error: "Set an owner email address before sending a test message.", domains };
    const tpl = testEmail({ at: new Date().toISOString(), from: this.resend.from });
    const result = await this.send({ to, subject: tpl.subject, html: tpl.html, text: tpl.text, category: "test" });
    return { ...result, domains };
  }

  async emailLog(limit = 50) {
    return listEmailLog(limit);
  }

  /**
   * A capability report for every integration. Every field reflects a genuine check or a
   * configured value; nothing is claimed that has not been verified.
   */
  async status(): Promise<Record<string, unknown>> {
    const [supabaseHealth, supabaseJwks, ownerEmail] = await Promise.all([
      this.supabase.health(),
      this.supabase.jwksReachable(),
      this.ownerEmail(),
    ]);
    let twelveUsage: { plan: string | null; perMinute: number | null; perDay: number | null; usedToday: number | null } | null = null;
    if (this.twelveData) {
      await this.twelveData.refreshPlan();
      const s = this.twelveData.status();
      twelveUsage = { plan: s.plan, perMinute: s.rateLimitPerMinute, perDay: s.dailyLimit, usedToday: s.requestsUsedToday };
    }
    return {
      marketData: {
        configured: Boolean(this.config.twelveDataApiKey),
        provider: this.config.marketDataProvider,
        twelveData: this.twelveData ? { ...this.twelveData.status(), usage: twelveUsage } : null,
        executionIsSeparate: true,
        note: "Market data and order execution are separate integrations. Twelve Data supplies prices; the active broker executes orders.",
      },
      email: {
        ...this.resend.status(),
        ownerEmail,
      },
      gemini: {
        configured: Boolean(this.config.geminiApiKey),
        model: this.config.geminiModel,
        fallbackModels: this.config.geminiFallbackModels,
        note: "Gemini produces analysis only. It cannot place or approve a trade; the risk engine and the owner keep that authority.",
      },
      supabase: {
        ...this.supabase.status(),
        health: supabaseHealth,
        jwks: supabaseJwks,
      },
    };
  }
}

/**
 * Wire critical engine notifications to email in addition to Telegram. Telegram keeps the
 * existing sink; this composes a second delivery path so an alert reaches the owner even
 * when Telegram is not configured.
 */
export function composeNotificationSinks(
  sinks: Array<(n: { severity: string; title: string; body: string; category: string }) => void>,
): (n: { severity: string; title: string; body: string; category: string }) => void {
  return (n) => {
    for (const sink of sinks) {
      try {
        sink(n);
      } catch {
        /* one channel failing must not stop the others */
      }
    }
  };
}
