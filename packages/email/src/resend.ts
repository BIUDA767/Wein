/**
 * Resend transactional-email client.
 *
 * Resend sends mail over a small REST API. This client:
 *  - reads the API key from configuration (the environment), never from source;
 *  - never logs or returns the key;
 *  - treats a send as successful only when Resend returns an id, and surfaces the
 *    provider's own error message otherwise, so a caller can never report a delivery
 *    that did not happen;
 *  - records delivery attempts so the platform can show real email state.
 *
 * Resend requires the `from` address to be on a domain verified in the Resend dashboard.
 * Until a domain is verified, only the shared sender `onboarding@resend.dev` is accepted;
 * the client reports that limitation rather than failing silently.
 */
import type { Logger } from "@phirst/core";

const BASE = "https://api.resend.com";

export interface ResendOptions {
  apiKey: string | null;
  /** Verified sender, e.g. `Wein <noreply@yourdomain.com>`. */
  from: string;
  replyTo?: string | null;
  log: Logger;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | null;
  /** Tags make the email findable in the Resend dashboard and in delivery stats. */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  ok: boolean;
  /** Resend's message id when the send was accepted. */
  id: string | null;
  error: string | null;
}

export interface EmailStatus {
  configured: boolean;
  from: string;
  /** True when the sender is the shared test sender rather than a verified domain. */
  usingSharedSender: boolean;
  /** Sending is possible but the sender address is not on a verified domain. */
  domainVerified: boolean | null;
  notes: string[];
}

export class ResendClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get available(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get from(): string {
    return this.opts.from;
  }

  private get usingSharedSender(): boolean {
    return /@resend\.dev>?$/i.test(this.opts.from);
  }

  status(): EmailStatus {
    const notes: string[] = [];
    if (!this.available) {
      notes.push("RESEND_API_KEY is not configured; transactional email is disabled.");
    } else if (this.usingSharedSender) {
      notes.push(
        "Sending from the shared sender onboarding@resend.dev. Deliverability is limited: verify a domain in Resend and set RESEND_FROM to send to arbitrary recipients.",
      );
    } else {
      notes.push(`Sending as ${this.opts.from}. The domain must be verified in the Resend dashboard or sends will be rejected.`);
    }
    return {
      configured: this.available,
      from: this.opts.from,
      usingSharedSender: this.usingSharedSender,
      domainVerified: null,
      notes,
    };
  }

  /** List domains so the UI can report whether the sender domain is genuinely verified. */
  async listDomains(): Promise<Array<{ id: string; name: string; status: string }>> {
    if (!this.opts.apiKey) throw new Error("RESEND_API_KEY is not configured");
    const res = await this.fetchImpl(`${BASE}/domains`, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(this.describeError(res.status, text));
    const body = JSON.parse(text) as { data?: Array<{ id: string; name: string; status: string }> };
    return body.data ?? [];
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.opts.apiKey) {
      return { ok: false, id: null, error: "RESEND_API_KEY is not configured" };
    }
    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    if (recipients.length === 0) return { ok: false, id: null, error: "At least one recipient is required" };

    const payload: Record<string, unknown> = {
      from: this.opts.from,
      to: recipients,
      subject: input.subject,
    };
    if (input.html) payload.html = input.html;
    if (input.text) payload.text = input.text;
    if (!input.html && !input.text) payload.text = input.subject;
    const replyTo = input.replyTo ?? this.opts.replyTo;
    if (replyTo) payload.reply_to = replyTo;
    if (input.tags) payload.tags = input.tags;

    try {
      const res = await this.fetchImpl(`${BASE}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) {
        const error = this.describeError(res.status, text);
        // Log the failure with the provider's reason but never the key or the full body.
        this.opts.log.warn("resend send failed", { status: res.status, subject: input.subject, error });
        return { ok: false, id: null, error };
      }
      const body = JSON.parse(text) as { id?: string };
      if (!body.id) {
        this.opts.log.warn("resend accepted the request without a message id", { subject: input.subject });
        return { ok: false, id: null, error: "Resend did not return a message id" };
      }
      this.opts.log.info("email sent", { id: body.id, subject: input.subject, recipients: recipients.length });
      return { ok: true, id: body.id, error: null };
    } catch (err) {
      const error = (err as Error).message;
      this.opts.log.warn("resend request error", { subject: input.subject, error });
      return { ok: false, id: null, error };
    }
  }

  /** Extract Resend's `message` field from an error body without echoing the whole payload. */
  private describeError(status: number, text: string): string {
    try {
      const body = JSON.parse(text) as { message?: string; name?: string };
      if (body.message) return `Resend HTTP ${status}: ${body.message}`;
    } catch {
      /* fall through to a generic message */
    }
    return `Resend HTTP ${status}`;
  }
}
