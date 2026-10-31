/**
 * Email templates. Plain, dark-themed HTML with a text fallback. Every dynamic value is
 * HTML-escaped, so a symbol or a strategy name can never inject markup into an inbox.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SHELL = (title: string, bodyHtml: string): string => `<!doctype html>
<html><body style="margin:0;background:#0b0b0c;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8e8ea">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#d4b878;margin-bottom:20px">WEIN</div>
    <h1 style="font-size:20px;font-weight:600;margin:0 0 16px">${escapeHtml(title)}</h1>
    <div style="font-size:14px;line-height:1.6;color:#c9c9cd">${bodyHtml}</div>
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #232326;font-size:12px;color:#77777d">
      Wein — calm in execution, precise in judgement.
    </div>
  </div>
</body></html>`;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function securityAlertEmail(input: { title: string; body: string; severity: string }): RenderedEmail {
  const bodyHtml = `<p>${escapeHtml(input.body)}</p>
    <p style="color:#77777d;font-size:12px">Severity: ${escapeHtml(input.severity)}</p>`;
  return {
    subject: `[Wein] ${input.title}`,
    html: SHELL(input.title, bodyHtml),
    text: `${input.title}\n\n${input.body}\n\nSeverity: ${input.severity}`,
  };
}

export function authEmail(input: { title: string; body: string; actionLabel?: string; actionUrl?: string }): RenderedEmail {
  const action = input.actionUrl
    ? `<p style="margin-top:20px"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;background:#3ddc97;color:#04120c;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(input.actionLabel ?? "Open Wein")}</a></p>`
    : "";
  return {
    subject: `[Wein] ${input.title}`,
    html: SHELL(input.title, `<p>${escapeHtml(input.body)}</p>${action}`),
    text: `${input.title}\n\n${input.body}${input.actionUrl ? `\n\n${input.actionUrl}` : ""}`,
  };
}

export function testEmail(input: { at: string; from: string }): RenderedEmail {
  return {
    subject: "[Wein] Email integration test",
    html: SHELL(
      "Email integration is working",
      `<p>This message confirms that Wein can send transactional email through Resend.</p>
       <p style="color:#77777d;font-size:12px">Sent ${escapeHtml(input.at)} from ${escapeHtml(input.from)}.</p>`,
    ),
    text: `Email integration is working.\nSent ${input.at} from ${input.from}.`,
  };
}
