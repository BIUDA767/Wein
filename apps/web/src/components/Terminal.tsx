"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { WatchQuote } from "@/lib/api";
import { formatMoney, type ActiveAccountState } from "@/lib/account";
import { Sheet, Spinner } from "./ui";
import { timeAgo } from "@/lib/format";

/**
 * The account-balance surface the terminal header reads.
 *
 * The balance shown is the one the broker reported for the selected account, formatted in
 * that account's own currency. When no account is selected the header says so instead of
 * showing a number, and when the fetch fails it shows the failure — never a zero.
 *
 * Tapping the balance opens a sheet listing every account the active broker returned, with
 * a one-tap switch. Switching while the engine holds exposure asks for confirmation on the
 * backend; that response is surfaced verbatim.
 */

export function AccountBalance({
  account,
  compact = false,
  onOpen,
}: {
  account: ActiveAccountState;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { status, account: acct, error } = account;

  const value = useMemo(() => {
    if (status === "loading") return "···";
    if (status === "no-account") return "—";
    if (status === "error") return "—";
    return formatMoney(acct?.balance ?? null, acct?.currency ?? "USD");
  }, [status, acct]);

  const sub = useMemo(() => {
    if (status === "loading") return "Loading balance…";
    if (status === "no-account") return "No account selected";
    if (status === "error") return error ?? "Balance unavailable";
    const kind = acct?.accountType === "real" ? "Real account" : "Demo account";
    return `${kind} · ${acct?.currency ?? "USD"}`;
  }, [status, acct, error]);

  return (
    <button
      onClick={onOpen}
      disabled={!onOpen}
      className={`group w-full text-left ${onOpen ? "active:scale-[0.99] transition" : "cursor-default"}`}
      aria-label="Account balance and account selection"
    >
      <div className="kpi-label">{compact ? "Balance" : "Account balance"}</div>
      <div
        className={`mono-num font-display tracking-tight ${
          compact ? "text-[20px]" : "text-[30px] leading-none"
        } ${status === "ready" ? "text-white" : "text-white/55"}`}
      >
        {value}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/40">
        {acct?.accountType === "real" && status === "ready" ? (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-ruby-400" />
        ) : (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/25" />
        )}
        <span className="truncate">{sub}</span>
        {onOpen && <span className="ml-0.5 text-white/30 transition group-hover:text-white/55">›</span>}
      </div>
    </button>
  );
}

/** Bottom sheet listing every account for the active broker, with one-tap activation. */
export function AccountSheet({
  open,
  onClose,
  account,
  notify,
}: {
  open: boolean;
  onClose: () => void;
  account: ActiveAccountState;
  notify: (text: string, tone?: "neutral" | "good" | "bad" | "warn") => void;
}) {
  const { accounts, account: active, brokerLabel, switching, switchAccount, refresh } = account;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const activate = async (id: string, confirm: boolean) => {
    setBusyId(id);
    try {
      await switchAccount(id, confirm);
      notify("Active account switched.", "good");
      setConfirmId(null);
      onClose();
    } catch (err) {
      // A 409 from the backend means "confirm required because exposure is open". Present
      // that as an explicit confirmation step rather than swallowing it.
      const message = (err as Error).message;
      if (/confirm/i.test(message)) {
        setConfirmId(id);
        notify(message, "warn");
      } else {
        notify(message, "bad");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet open={open} title="Accounts" onClose={onClose}>
      <p className="mb-3 text-[12px] leading-relaxed text-white/45">
        {brokerLabel ? `${brokerLabel} — ` : ""}the engine trades the active account. Switching while positions are open asks for confirmation first.
      </p>
      {accounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/12 px-4 py-6 text-center text-[12.5px] text-white/45">
          No accounts reported. Connect a broker in Controls to load its accounts.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => {
            const isActive = active?.id === a.id;
            return (
              <div key={a.id} className={`tile px-4 py-3 ${isActive ? "tile-active" : ""}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold text-white">
                        {a.label || a.loginid || a.accountId}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          a.accountType === "real"
                            ? "border-ruby-500/40 bg-ruby-500/10 text-ruby-400"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                        }`}
                      >
                        {a.accountType}
                      </span>
                    </div>
                    <div className="mt-0.5 mono-num text-[11.5px] text-white/40">
                      {formatMoney(a.balance, a.currency)} · {a.currency}
                      {a.loginid ? ` · ${a.loginid}` : ""}
                    </div>
                  </div>
                  {isActive ? (
                    <span className="shrink-0 rounded-full border border-champagne-500/40 bg-champagne-500/10 px-2.5 py-1 text-[11px] font-semibold text-champagne-300">
                      Active
                    </span>
                  ) : (
                    <button
                      className="btn-ghost shrink-0 !px-3 !py-1.5 !text-[12px]"
                      disabled={switching || busyId !== null}
                      onClick={() => void activate(a.id, confirmId === a.id)}
                    >
                      {busyId === a.id ? <Spinner size={13} /> : confirmId === a.id ? "Confirm" : "Activate"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Live watchlist with real quotes. Adding and removing persists to the backend; the quote
 * for each row comes from the active market-data provider. A row whose quote fails shows
 * "unavailable" rather than a stale or invented number.
 */
export function Watchlist({
  onSelect,
  current,
  notify,
}: {
  onSelect: (symbol: string) => void;
  current: string;
  notify: (text: string, tone?: "neutral" | "good" | "bad" | "warn") => void;
}) {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [quotes, setQuotes] = useState<Record<string, WatchQuote | null>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadQuotes = async () => {
    try {
      const res = await api.get<{ quotes: Record<string, WatchQuote | null> }>("/api/watchlist/quotes");
      setQuotes(res.quotes);
    } catch {
      /* keep the last good quotes; the poll retries */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ symbols: string[] }>("/api/watchlist");
        setSymbols(res.symbols);
      } catch (err) {
        notify((err as Error).message, "bad");
      } finally {
        setLoading(false);
      }
    })();
  }, [notify]);

  useEffect(() => {
    if (symbols.length === 0) return;
    void loadQuotes();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadQuotes();
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(",")]);

  const remove = async (symbol: string) => {
    setBusy(true);
    try {
      const res = await api.del<{ symbols: string[] }>(`/api/watchlist/${encodeURIComponent(symbol)}`);
      setSymbols(res.symbols);
    } catch (err) {
      notify((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {symbols.map((s) => {
        const q = quotes[s];
        return (
          <div key={s} className={`tile flex items-center justify-between px-4 py-3 ${s === current ? "tile-active" : ""}`}>
            <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(s)}>
              <div className="truncate text-[13.5px] font-semibold text-white">{s}</div>
              <div className="mt-0.5 text-[11px] text-white/40">
                {q ? `bid ${q.bid.toFixed(4)} · ask ${q.ask.toFixed(4)}` : "quote unavailable"}
              </div>
            </button>
            <div className="flex items-center gap-2">
              <span className="mono-num text-[13.5px] font-semibold text-white">
                {q ? q.mid.toFixed(4) : "—"}
              </span>
              <button
                className="rounded-full border border-white/12 px-2 py-1 text-[11px] text-white/45 transition hover:border-ruby-500/40 hover:text-ruby-400 active:scale-95"
                disabled={busy}
                onClick={() => void remove(s)}
                aria-label={`Remove ${s} from watchlist`}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Price alerts. An alert is armed against the live quote and fires once, recording the
 * crossing in the notification feed. Alerts are listed with their real trigger state.
 */
export function AlertsPanel({
  notify,
}: {
  notify: (text: string, tone?: "neutral" | "good" | "bad" | "warn") => void;
}) {
  const [alerts, setAlerts] = useState<Array<{ id: string; symbol: string; above: number | null; below: number | null; triggeredAt: string | null; triggeredPrice: number | null }>>([]);
  const [symbol, setSymbol] = useState("");
  const [above, setAbove] = useState("");
  const [below, setBelow] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.get<{ alerts: typeof alerts }>("/api/alerts");
      setAlerts(res.alerts);
    } catch (err) {
      notify((err as Error).message, "bad");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!symbol.trim()) {
      notify("Enter a symbol for the alert.", "warn");
      return;
    }
    const up = above.trim() === "" ? null : Number(above);
    const down = below.trim() === "" ? null : Number(below);
    if (up === null && down === null) {
      notify("Set an upper or lower threshold.", "warn");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/alerts", { symbol: symbol.trim(), above: up, below: down });
      notify(`Alert armed for ${symbol.trim()}.`, "good");
      setSymbol("");
      setAbove("");
      setBelow("");
      await load();
    } catch (err) {
      notify((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/alerts/${encodeURIComponent(id)}`);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      notify((err as Error).message, "bad");
    }
  };

  return (
    <div>
      <div className="tile mb-3 space-y-2 p-3">
        <input className="field" placeholder="Symbol, e.g. R_100" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="field mono-num" placeholder="Above" inputMode="decimal" value={above} onChange={(e) => setAbove(e.target.value)} />
          <input className="field mono-num" placeholder="Below" inputMode="decimal" value={below} onChange={(e) => setBelow(e.target.value)} />
        </div>
        <button className="btn-primary w-full" disabled={busy} onClick={() => void create()}>
          {busy ? <Spinner /> : "Arm alert"}
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : alerts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/12 px-4 py-6 text-center text-[12.5px] text-white/45">
          No alerts armed. An alert fires once, from a real quote crossing your threshold.
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div key={a.id} className="tile flex items-center justify-between px-4 py-3">
              <div>
                <div className="text-[13px] font-semibold text-white">{a.symbol}</div>
                <div className="mt-0.5 text-[11px] text-white/40">
                  {a.above !== null ? `≥ ${a.above}` : ""}
                  {a.above !== null && a.below !== null ? " · " : ""}
                  {a.below !== null ? `≤ ${a.below}` : ""}
                  {a.triggeredAt ? ` · triggered at ${a.triggeredPrice} ${timeAgo(a.triggeredAt)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    a.triggeredAt
                      ? "border-champagne-500/40 bg-champagne-500/10 text-champagne-300"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  }`}
                >
                  {a.triggeredAt ? "Fired" : "Armed"}
                </span>
                <button
                  className="rounded-full border border-white/12 px-2 py-1 text-[11px] text-white/45 transition hover:border-ruby-500/40 hover:text-ruby-400 active:scale-95"
                  onClick={() => void remove(a.id)}
                  aria-label="Delete alert"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
