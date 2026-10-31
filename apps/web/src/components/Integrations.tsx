"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiFailure,
  type EmailLogRecord,
  type IntegrationStatus,
  type SupabaseIdentityRecord,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Card, EmptyState, Pill, Row, SectionTitle, Spinner } from "./ui";

/**
 * Integration control centre. Every control here calls a real owner-only route and every
 * value shown comes from a live probe or a configured setting. Nothing is mocked: a
 * capability that is not configured is reported as such rather than shown as working.
 */
export function IntegrationsScreen({ notify }: { notify: (t: string, tone?: "neutral" | "good" | "bad" | "warn") => void }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [log, setLog] = useState<EmailLogRecord[]>([]);
  const [identity, setIdentity] = useState<SupabaseIdentityRecord | null>(null);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [token, setToken] = useState("");
  const [quoteSymbol, setQuoteSymbol] = useState("EUR/USD");
  const [quote, setQuote] = useState<{ symbol: string; mid: number; epochMs: number } | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, e, sb] = await Promise.all([
        api.get<{ integrations: IntegrationStatus }>("/api/integrations/status"),
        api.get<{ log: EmailLogRecord[] }>("/api/integrations/email"),
        api.get<{ identity: SupabaseIdentityRecord | null }>("/api/integrations/supabase"),
      ]);
      setStatus(s.integrations);
      setLog(e.log);
      setIdentity(sb.identity);
      setOwnerEmail(s.integrations.email.ownerEmail ?? "");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const saveOwnerEmail = () =>
    run("email-save", async () => {
      await api.put("/api/integrations/email/owner", { email: ownerEmail.trim() || null });
      notify("Notification address saved.", "good");
      await load();
    });

  const sendTest = () =>
    run("email-test", async () => {
      const res = await api.post<{ ok: boolean; id: string | null; error: string | null; domains: Array<{ name: string; status: string }> }>(
        "/api/integrations/email/test",
      );
      // Report the provider's real outcome; never claim a delivery that failed.
      if (res.ok) notify(`Test email accepted by Resend (id ${res.id}).`, "good");
      else notify(res.error ?? "Resend rejected the test email.", "bad");
      await load();
    });

  const setProvider = (provider: "deriv" | "twelve_data") =>
    run("provider", async () => {
      await api.put("/api/integrations/market-data/provider", { provider });
      notify(`Market data provider set to ${provider}. The engine applies it on its next broker refresh.`, "good");
      await load();
    });

  const fetchQuote = () =>
    run("quote", async () => {
      const res = await api.get<{ quote: { symbol: string; mid: number; epochMs: number } }>(
        `/api/integrations/market-data/quote?symbol=${encodeURIComponent(quoteSymbol.trim())}`,
      );
      setQuote(res.quote);
    });

  const verifyToken = () =>
    run("verify", async () => {
      const res = await api.post<{ valid: boolean; claims?: { sub: string; email: string | null; role: string | null } }>(
        "/api/integrations/supabase/verify-token",
        { token: token.trim() },
      );
      if (res.valid) notify(`Token verified for ${res.claims?.email ?? res.claims?.sub}.`, "good");
      else notify("That token did not verify against the project's signing keys.", "bad");
    });

  const linkIdentity = () =>
    run("link", async () => {
      const res = await api.post<{ ok: boolean; supabaseUserId: string; email: string | null }>("/api/integrations/supabase/link", { token: token.trim() });
      notify(`Linked Supabase identity ${res.email ?? res.supabaseUserId}.`, "good");
      await load();
    });

  const unlinkIdentity = () =>
    run("unlink", async () => {
      await api.del("/api/integrations/supabase/link");
      notify("Supabase identity unlinked.", "good");
      await load();
    });

  const runAnalysis = () =>
    run("analysis", async () => {
      const res = await api.post<{ ok: boolean; analysis?: string; error?: string; model: string }>("/api/integrations/gemini/analyze", {});
      if (res.ok && res.analysis) setAnalysis(res.analysis);
      else notify(res.error ?? "AI analysis failed.", "bad");
    });

  if (!status) {
    return <Card><div className="flex justify-center py-8"><Spinner /></div></Card>;
  }

  const md = status.marketData;
  const td = md.twelveData;
  // Tolerate an older API payload: a screen must never white-screen the whole app because
  // one field is missing. Missing probe results read as "unknown", not as a crash.
  const sbHealth = status.supabase.health ?? { ok: false, detail: "unknown", keyRejected: false };
  const sbJwks = status.supabase.jwks ?? { ok: false, detail: "unknown", keyCount: 0 };

  return (
    <div className="space-y-3">
      {/* Market data -------------------------------------------------------- */}
      <Card>
        <SectionTitle action={<Pill tone={md.configured ? "good" : "warn"}>{md.configured ? "configured" : "not configured"}</Pill>}>
          Market data
        </SectionTitle>
        <p className="mb-3 text-[11.5px] leading-relaxed text-white/45">{md.note}</p>
        <div className="mb-3 flex gap-2">
          {(["deriv", "twelve_data"] as const).map((p) => (
            <button
              key={p}
              onClick={() => void setProvider(p)}
              disabled={busy === "provider" || (p === "twelve_data" && !td?.configured)}
              className={`chip flex-1 ${md.provider === p ? "chip-active" : ""} disabled:opacity-40`}
            >
              {p === "deriv" ? "Broker feed" : "Twelve Data"}
            </button>
          ))}
        </div>
        {td ? (
          <>
            <Row label="Plan" value={td.plan ?? "unknown"} />
            <Row label="Rate limit" value={td.rateLimitPerMinute !== null ? `${td.rateLimitPerMinute}/min` : "unknown"} />
            <Row label="Daily budget" value={td.dailyLimit !== null ? `${td.requestsUsedToday ?? 0} / ${td.dailyLimit}` : "unknown"} />
            {td.notes.map((n, i) => (
              <p key={i} className="mt-1.5 text-[10.5px] leading-relaxed text-white/35">{n}</p>
            ))}
          </>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-white/40">
            Twelve Data is not configured. Set TWELVE_DATA_API_KEY to add quotes, historical candles and a broader instrument list.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <input
            className="field flex-1"
            value={quoteSymbol}
            onChange={(e) => setQuoteSymbol(e.target.value)}
            placeholder="Symbol, e.g. EUR/USD"
            aria-label="Symbol to quote"
          />
          <button className="btn-ghost px-4 text-[12px]" onClick={() => void fetchQuote()} disabled={busy === "quote" || !td?.configured}>
            {busy === "quote" ? <Spinner /> : "Quote"}
          </button>
        </div>
        {quote && (
          <div className="mt-2 rounded-xl border border-white/8 px-3 py-2 text-[12px] text-white/70">
            <span className="mono-num text-white/90">{quote.symbol}</span> · {quote.mid} · provider timestamp {new Date(quote.epochMs).toLocaleTimeString()}
            <div className="mt-1 text-[10.5px] text-white/35">Twelve Data publishes a single last price; no bid/ask spread is fabricated.</div>
          </div>
        )}
      </Card>

      {/* Email -------------------------------------------------------------- */}
      <Card>
        <SectionTitle action={<Pill tone={status.email.configured ? "good" : "warn"}>{status.email.configured ? "configured" : "not configured"}</Pill>}>
          Transactional email
        </SectionTitle>
        <Row label="Provider" value="Resend" />
        <Row label="Sender" value={status.email.from} />
        {status.email.notes.map((n, i) => (
          <p key={i} className="mt-1.5 text-[10.5px] leading-relaxed text-white/35">{n}</p>
        ))}
        <div className="mt-3">
          <label className="label" htmlFor="owner-email">Notification address</label>
          <div className="flex gap-2">
            <input
              id="owner-email"
              className="field flex-1"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@yourdomain.com"
              inputMode="email"
            />
            <button className="btn-ghost px-4 text-[12px]" onClick={() => void saveOwnerEmail()} disabled={busy === "email-save"}>
              {busy === "email-save" ? <Spinner /> : "Save"}
            </button>
          </div>
        </div>
        <button className="btn-primary mt-3 w-full" onClick={() => void sendTest()} disabled={busy === "email-test" || !status.email.configured}>
          {busy === "email-test" ? <Spinner /> : "Send test email"}
        </button>
      </Card>

      {/* Email delivery log ------------------------------------------------- */}
      <Card>
        <SectionTitle>Email delivery log</SectionTitle>
        {log.length === 0 ? (
          <EmptyState title="No email sent yet" body="Delivery attempts appear here, with the provider's own outcome." />
        ) : (
          log.slice(0, 12).map((e) => (
            <div key={e.id} className="border-b border-white/6 py-2.5 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12.5px] text-white/85">{e.subject}</span>
                <Pill tone={e.ok ? "good" : "bad"}>{e.ok ? "sent" : "failed"}</Pill>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate text-[10.5px] text-white/35">{e.toAddress} · {e.category} · {timeAgo(e.createdAt)}</span>
              </div>
              {e.error && <p className="mt-1 text-[10.5px] leading-relaxed text-ruby-400/80">{e.error}</p>}
            </div>
          ))
        )}
      </Card>

      {/* Gemini ------------------------------------------------------------- */}
      <Card>
        <SectionTitle action={<Pill tone={status.gemini.configured ? "good" : "warn"}>{status.gemini.configured ? "configured" : "not configured"}</Pill>}>
          AI analysis
        </SectionTitle>
        <Row label="Model" value={status.gemini.model} />
        <Row label="Fallbacks" value={status.gemini.fallbackModels.join(", ") || "none"} />
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-white/35">{status.gemini.note}</p>
        <button className="btn-ghost mt-3 w-full py-2.5 text-[12px]" onClick={() => void runAnalysis()} disabled={busy === "analysis" || !status.gemini.configured}>
          {busy === "analysis" ? <Spinner /> : "Analyse current account"}
        </button>
        {analysis && (
          <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.02] p-3 text-[12px] leading-relaxed text-white/70 whitespace-pre-wrap">
            <Pill tone="gold">AI opinion</Pill>
            <div className="mt-2">{analysis}</div>
          </div>
        )}
      </Card>

      {/* Supabase ----------------------------------------------------------- */}
      <Card>
        <SectionTitle action={<Pill tone={sbHealth.ok ? "good" : "warn"}>{sbHealth.ok ? "reachable" : "attention"}</Pill>}>
          Supabase
        </SectionTitle>
        <Row label="Project" value={status.supabase.url ?? "not configured"} />
        <Row label="Auth health" value={sbHealth.detail} />
        <Row label="Signing keys" value={sbJwks.ok ? sbJwks.detail : `${sbJwks.detail} (unavailable)`} />
        <Row label="Anon key" value={status.supabase.hasAnonKey ? "present" : "absent"} />
        <Row label="Service-role key" value={status.supabase.hasServiceRoleKey ? "present (server-only)" : "absent"} />
        {status.supabase.notes.map((n, i) => (
          <p key={i} className="mt-1.5 text-[10.5px] leading-relaxed text-white/35">{n}</p>
        ))}
        {sbHealth.keyRejected && (
          <p className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            The Supabase API keys were rejected by this project. The URL and the keys appear to belong to different projects.
            Replace SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY with keys from the project at this URL.
          </p>
        )}
        <div className="mt-3">
          <label className="label" htmlFor="sb-token">Supabase access token</label>
          <textarea
            id="sb-token"
            className="field mono-num h-20 resize-none text-[11px]"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste a Supabase access token to verify or link"
          />
          <div className="mt-2 flex gap-2">
            <button className="btn-ghost flex-1 py-2.5 text-[12px]" onClick={() => void verifyToken()} disabled={busy === "verify" || token.trim().length === 0}>
              {busy === "verify" ? <Spinner /> : "Verify token"}
            </button>
            <button className="btn-ghost flex-1 py-2.5 text-[12px]" onClick={() => void linkIdentity()} disabled={busy === "link" || token.trim().length === 0}>
              {busy === "link" ? <Spinner /> : "Link identity"}
            </button>
          </div>
        </div>
        {identity && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-white/8 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] text-white/85">{identity.email ?? identity.supabaseUserId}</div>
              <div className="text-[10.5px] text-white/35">linked {timeAgo(identity.linkedAt)}</div>
            </div>
            <button className="text-[11px] text-ruby-400/80" onClick={() => void unlinkIdentity()} disabled={busy === "unlink"}>
              Unlink
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
