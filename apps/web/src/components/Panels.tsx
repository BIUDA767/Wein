"use client";

import { useEffect, useState } from "react";
import { api, ApiFailure, type BrokerRecord, type MemoryRecord, type PerformanceReport, type ProviderSpec, type TelegramStatus, type VoiceSettings } from "@/lib/api";
import type { AppState } from "@/lib/store";
import { ConfirmDialog, EmptyState, Pill, Row, SectionTitle, Spinner, Switch } from "./ui";
import { money, signed, titleCase } from "@/lib/format";

type PanelKey = "authority" | "appearance" | "brokers" | "risk" | "strategies" | "phirst" | "voice" | "notifications" | "telegram" | "security" | "system";

const PANELS: Array<{ key: PanelKey; label: string; hint: string }> = [
  { key: "authority", label: "Trading authority", hint: "Manual, approval or autonomous" },
  { key: "appearance", label: "Appearance", hint: "Chart, layout, dashboard and sound" },
  { key: "brokers", label: "Broker connections", hint: "Connect, verify and activate brokers" },
  { key: "risk", label: "Risk configuration", hint: "Limits enforced by the backend" },
  { key: "strategies", label: "Strategies", hint: "Built-in and custom, with approval" },
  { key: "phirst", label: "PHIRST2 settings", hint: "Identity, model and memory" },
  { key: "voice", label: "Voice & avatar", hint: "Voice, accent and animation" },
  { key: "notifications", label: "Notifications", hint: "Alerts and proactive warnings" },
  { key: "telegram", label: "Telegram", hint: "Remote commands and permissions" },
  { key: "security", label: "Security & memory", hint: "Sessions, audit and AI memory" },
  { key: "system", label: "System", hint: "Health, diagnostics and deployment" },
];

export function Panels({ app, perf, onRefresh, initialPanel }: { app: AppState; perf: PerformanceReport | null; onClose: () => void; onRefresh: () => Promise<void>; initialPanel?: PanelKey }) {
  const [open, setOpen] = useState<PanelKey | null>(initialPanel ?? null);

  if (open) {
    return (
      <div>
        <button onClick={() => setOpen(null)} className="mb-4 flex items-center gap-1.5 text-[12.5px] text-white/55">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" strokeLinecap="round" /></svg>
          All controls
        </button>
        {open === "authority" && <AuthorityPanel app={app} />}
        {open === "appearance" && <AppearancePanel app={app} />}
      {open === "brokers" && <BrokerPanel app={app} />}
        {open === "risk" && <RiskPanel app={app} />}
        {open === "strategies" && <StrategyPanel app={app} />}
        {open === "phirst" && <PhirstPanel app={app} perf={perf} />}
        {open === "voice" && <VoicePanel app={app} />}
        {open === "notifications" && <NotificationPanel app={app} />}
        {open === "telegram" && <TelegramPanel app={app} />}
        {open === "security" && <SecurityPanel app={app} />}
        {open === "system" && <SystemPanel app={app} onRefresh={onRefresh} />}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {PANELS.map((p) => (
        <button
          key={p.key}
          onClick={() => setOpen(p.key)}
          className="flex w-full items-center justify-between rounded-2xl border tile px-4 py-3.5 text-left active:scale-[0.99]"
        >
          <div>
            <div className="text-[14px] font-medium text-white">{p.label}</div>
            <div className="mt-0.5 text-[11.5px] text-white/40">{p.hint}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/30"><path d="M9 6l6 6-6 6" strokeLinecap="round" /></svg>
        </button>
      ))}
    </div>
  );
}

// --- Trading authority (manual | approval | autonomous) -----------------------

const MODE_COPY: Record<"manual" | "approval" | "autonomous", { title: string; body: string; tone: "neutral" | "gold" | "bad" }> = {
  manual: {
    title: "Manual",
    body: "PHIRST2 analyses and recommends only. No autonomous order is ever placed; you open every trade yourself.",
    tone: "neutral",
  },
  approval: {
    title: "Approval",
    body: "PHIRST2 prepares a concrete, risk-sized trade and waits. Nothing executes until you approve it. Proposals expire if the price moves too far.",
    tone: "gold",
  },
  autonomous: {
    title: "Autonomous",
    body: "PHIRST2 executes qualifying trades inside your risk limits. The risk engine still holds final veto, and the independent validator can still block or escalate a trade.",
    tone: "bad",
  },
};

/**
 * The authority control. It reads the mode from the backend and changes it there — the
 * value shown is never a local guess. Changing authority is refused while the engine is
 * running, so no order is caught mid-flight; the panel says so rather than failing silently.
 */
function AuthorityPanel({ app }: { app: AppState }) {
  const { engine, refresh, notify } = app;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = engine?.tradingMode ?? "manual";
  const running = engine?.state === "running";

  const change = async (mode: "manual" | "approval" | "autonomous") => {
    if (mode === current) return;
    setBusy(mode);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>("/api/engine/trading-mode", { mode });
      await refresh();
      notify(res.message, "good");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(id + action);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/proposals/${id}/${action}`);
      await refresh();
      notify(res.message, action === "approve" ? "good" : "neutral");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pending = engine?.pendingProposals ?? [];

  return (
    <div>
      <SectionTitle>Trading authority</SectionTitle>
      <p className="mb-4 text-[11.5px] leading-relaxed text-white/40">
        This decides how much PHIRST2 may do on its own. It is enforced by the trading engine, not by this screen, and it is persisted so a restart never widens it. It is a separate axis from paper/live.
      </p>

      {running && (
        <div className="mb-4 rounded-2xl border border-amber-400/25 bg-amber-400/8 px-3 py-2.5 text-[12px] text-amber-200/90">
          Pause the engine to change authority, so no order is caught mid-flight.
        </div>
      )}

      <div className="mb-5 space-y-2">
        {(Object.keys(MODE_COPY) as Array<keyof typeof MODE_COPY>).map((mode) => {
          const copy = MODE_COPY[mode];
          const active = current === mode;
          return (
            <button
              key={mode}
              disabled={busy !== null || running}
              onClick={() => void change(mode)}
              className={`w-full rounded-2xl border px-4 py-3.5 text-left transition active:scale-[0.99] disabled:opacity-60 ${
                active ? "border-champagne-500/45 bg-champagne-500/8" : "tile"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-medium text-white">{copy.title}</span>
                {active ? <Pill tone={copy.tone}>active</Pill> : busy === mode ? <Spinner size={14} /> : null}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-white/45">{copy.body}</p>
            </button>
          );
        })}
      </div>

      <SectionTitle
        action={pending.length > 0 ? <Pill tone="gold">{pending.length}</Pill> : undefined}
      >
        Awaiting your approval
      </SectionTitle>
      {pending.length === 0 ? (
        <EmptyState
          title="No pending proposals"
          body={current === "approval" ? "When PHIRST2 finds a qualifying trade it will appear here for your decision." : "Switch to approval mode to review trades before they execute."}
        />
      ) : (
        <div className="space-y-2">
          {pending.map((p) => (
            <div key={p.id} className="rounded-2xl border tile p-3.5">
              <div className="flex items-center justify-between">
                <span className={`text-[13.5px] font-semibold ${p.side === "buy" ? "text-emerald-400" : "text-ruby-400"}`}>
                  {p.side.toUpperCase()} {p.symbol}
                </span>
                <span className="mono-num text-[13px] text-white/80">{money(p.amount)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/45">
                <span>{p.durationSec}s contract</span>
                {p.referencePrice !== null && <span>at {p.referencePrice}</span>}
                <span>expires {new Date(p.expiresAt).toLocaleTimeString()}</span>
              </div>
              {p.rationale && <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/50">{p.rationale}</p>}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button className="btn-primary py-2.5" disabled={busy !== null} onClick={() => void decide(p.id, "approve")}>
                  {busy === p.id + "approve" ? <Spinner size={14} /> : "Approve"}
                </button>
                <button className="btn-ghost py-2.5" disabled={busy !== null} onClick={() => void decide(p.id, "reject")}>
                  {busy === p.id + "reject" ? <Spinner size={14} /> : "Reject"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="mt-3 rounded-2xl border border-ruby-500/30 bg-ruby-500/8 px-3 py-2.5 text-[12px] text-ruby-400">{error}</div>}
    </div>
  );
}

// --- Appearance & personalisation ---------------------------------------------

/**
 * Every control here changes something real: the chart re-renders in the chosen style,
 * the dashboard shows the chosen tiles, the trade sheet opens with the chosen defaults,
 * and the sound engine respects the mute and volume. Preferences are persisted on the
 * server, so they survive a reload and apply on any device.
 */
function AppearancePanel({ app }: { app: AppState }) {
  const prefs = app.prefs;
  const [draft, setDraft] = useState(prefs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (prefs) setDraft(prefs); }, [prefs]);

  if (!draft) return <div className="py-6 text-center text-[12px] text-white/40">Loading preferences…</div>;

  const save = async (next: typeof draft) => {
    setBusy(true);
    setError(null);
    // Optimistic: the UI updates immediately and reverts if the server refuses.
    const previous = draft;
    setDraft(next);
    try {
      const res = await api.put<{ preferences: typeof next }>("/api/preferences", next);
      setDraft(res.preferences);
      app.setPrefs(res.preferences);
      app.notify("Appearance saved.", "good");
    } catch (err) {
      setDraft(previous);
      const msg = err instanceof ApiFailure ? err.message : (err as Error).message;
      setError(msg);
      app.notify(msg, "bad");
    } finally {
      setBusy(false);
    }
  };

  const ALL_TILES: Array<{ key: string; label: string }> = [
    { key: "equity", label: "Equity" },
    { key: "balance", label: "Balance" },
    { key: "pnl", label: "P&L today" },
    { key: "open", label: "Open trades" },
    { key: "drawdown", label: "Drawdown" },
    { key: "winrate", label: "Win rate" },
  ];
  const ALL_TIMEFRAMES: Array<{ sec: number; label: string }> = [
    { sec: 5, label: "5s" }, { sec: 15, label: "15s" }, { sec: 60, label: "1m" },
    { sec: 300, label: "5m" }, { sec: 900, label: "15m" }, { sec: 3600, label: "1h" },
    { sec: 14400, label: "4h" }, { sec: 86400, label: "1d" },
  ];

  const toggleIn = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="space-y-4">
      <SectionTitle>Chart</SectionTitle>
      <div className="glass p-4">
        <label className="label">Style</label>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(["candles", "hollow", "line", "area"] as const).map((style) => (
            <button
              key={style}
              onClick={() => void save({ ...draft, chartStyle: style })}
              className={`chip capitalize ${draft.chartStyle === style ? "chip-active" : ""}`}
            >
              {style}
            </button>
          ))}
        </div>

        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Grid lines</div>
            <div className="text-[11px] text-white/35">Horizontal price guides</div>
          </div>
          <Switch checked={draft.chartGrid} label="Grid lines" onChange={(v) => void save({ ...draft, chartGrid: v })} />
        </div>

        <label className="label">Chart height — {draft.chartHeight}px</label>
        <input
          type="range"
          min={200}
          max={640}
          step={20}
          value={draft.chartHeight}
          onChange={(e) => setDraft({ ...draft, chartHeight: Number(e.target.value) })}
          onPointerUp={() => void save(draft)}
          onKeyUp={() => void save(draft)}
          className="w-full accent-emerald-500"
        />
      </div>

      <SectionTitle>Indicators on load</SectionTitle>
      <div className="glass p-4">
        <div className="flex flex-wrap gap-1.5">
          {[{ k: "ema", l: "EMA" }, { k: "sma", l: "SMA" }, { k: "bollinger", l: "Bollinger" }, { k: "rsi", l: "RSI" }].map((i) => (
            <button
              key={i.k}
              onClick={() => void save({ ...draft, defaultIndicators: toggleIn(draft.defaultIndicators, i.k) })}
              className={`chip ${draft.defaultIndicators.includes(i.k) ? "chip-active" : ""}`}
            >
              {i.l}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          These are the indicators selected when the app opens. You can still toggle any indicator from the chart at any time.
        </p>
      </div>

      <SectionTitle>Timeframes</SectionTitle>
      <div className="glass p-4">
        <div className="flex flex-wrap gap-1.5">
          {ALL_TIMEFRAMES.map((tf) => (
            <button
              key={tf.sec}
              onClick={() => void save({ ...draft, timeframes: toggleIn(draft.timeframes, tf.sec) })}
              className={`chip ${draft.timeframes.includes(tf.sec) ? "chip-active" : ""}`}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          Only the selected timeframes appear in the chart selector. At least one must remain.
        </p>
      </div>

      <SectionTitle>Dashboard tiles</SectionTitle>
      <div className="glass p-4">
        <div className="flex flex-wrap gap-1.5">
          {ALL_TILES.map((t) => (
            <button
              key={t.key}
              onClick={() => void save({ ...draft, dashboardTiles: toggleIn(draft.dashboardTiles, t.key) })}
              className={`chip ${draft.dashboardTiles.includes(t.key) ? "chip-active" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <SectionTitle>Trade defaults</SectionTitle>
      <div className="glass p-4">
        <label className="label">Default amount</label>
        <input
          className="field mono-num mb-4"
          inputMode="decimal"
          value={String(draft.defaultAmount)}
          onChange={(e) => setDraft({ ...draft, defaultAmount: Number(e.target.value) || 0 })}
          onBlur={() => void save(draft)}
        />
        <label className="label">Default duration (seconds)</label>
        <input
          className="field mono-num"
          inputMode="numeric"
          value={String(draft.defaultDurationSec)}
          onChange={(e) => setDraft({ ...draft, defaultDurationSec: Math.floor(Number(e.target.value)) || 0 })}
          onBlur={() => void save(draft)}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          The order sheet opens with these values. The risk engine may still reduce the amount.
        </p>
      </div>

      <SectionTitle>Sound</SectionTitle>
      <div className="glass p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Sound identity</div>
            <div className="text-[11px] text-white/35">Launch, feedback and alert cues</div>
          </div>
          <Switch checked={draft.soundEnabled} label="Sound" onChange={(v) => void save({ ...draft, soundEnabled: v })} />
        </div>
        <label className="label">Volume — {Math.round(draft.soundVolume * 100)}%</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={draft.soundVolume}
          disabled={!draft.soundEnabled}
          onChange={(e) => setDraft({ ...draft, soundVolume: Number(e.target.value) })}
          onPointerUp={() => void save(draft)}
          onKeyUp={() => void save(draft)}
          className="w-full accent-emerald-500 disabled:opacity-40"
        />
      </div>

      <SectionTitle>Motion</SectionTitle>
      <div className="glass p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Reduce motion</div>
            <div className="text-[11px] text-white/35">Also honours the system setting automatically</div>
          </div>
          <Switch checked={draft.reducedMotion} label="Reduce motion" onChange={(v) => void save({ ...draft, reducedMotion: v })} />
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-ruby-500/35 bg-ruby-500/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-ruby-400">{error}</div>
      )}
      {busy && <div className="text-center text-[11px] text-white/35">Saving…</div>}
    </div>
  );
}

// --- Broker connections -------------------------------------------------------

function BrokerPanel({ app }: { app: AppState }) {
  const [providers, setProviders] = useState<ProviderSpec[]>([]);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("deriv");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; message: string; authenticated: boolean } | null>(null);
  const [accounts, setAccounts] = useState<Record<string, Array<{ id: string; account_id: string; account_type: string; currency: string; balance: string | number | null; loginid: string | null; is_active: boolean }>>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ providers: ProviderSpec[] }>("/api/brokers/providers");
        setProviders(res.providers);
      } catch (err) {
        app.notify((err as Error).message, "bad");
      }
    })();
  }, [app]);

  const spec = providers.find((p) => p.id === provider);

  const loadAccounts = async (brokerId: string) => {
    try {
      const res = await api.get<{ accounts: Array<{ id: string; account_id: string; account_type: string; currency: string; balance: string | number | null; loginid: string | null; is_active: boolean }> }>(`/api/brokers/${brokerId}/accounts`);
      setAccounts((prev) => ({ ...prev, [brokerId]: res.accounts }));
    } catch {
      /* not fatal */
    }
  };

  useEffect(() => {
    for (const b of app.brokers) void loadAccounts(b.id);
  }, [app.brokers]);

  const add = async () => {
    setBusy(true);
    setResult(null);
    try {
      const credentials: Record<string, string> = {};
      if (token.trim()) credentials.token = token.trim();
      if (appId.trim()) credentials.appId = appId.trim();
      const res = await api.post<{ id: string; verified: boolean; authenticated: boolean; message: string }>("/api/brokers", {
        provider, label: label.trim() || spec?.name || provider, credentials,
      });
      setResult({ verified: res.verified, authenticated: res.authenticated, message: res.message });
      setLabel("");
      setToken("");
      setAppId("");
      await app.refresh();
      await loadAccounts(res.id);
      if (res.verified) {
        setAdding(false);
        app.notify(`${spec?.name ?? provider} verified and connected.`, "good");
      }
    } catch (err) {
      app.notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (id: string) => {
    setBusy(true);
    try {
      const res = await api.post<{ verified: boolean; authenticated: boolean; message: string }>(`/api/brokers/${id}/verify`);
      app.notify(res.verified ? `Verified: ${res.message}` : `Verification failed: ${res.message}`, res.verified ? "good" : "bad");
      await app.refresh();
      await loadAccounts(id);
    } catch (err) {
      app.notify((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Connected brokers</SectionTitle>
      {app.brokers.length === 0 && !adding && (
        <EmptyState title="No brokers connected" body="Connect a broker to receive live market data and place real orders. Paper mode uses live market data with simulated execution." />
      )}

      {app.brokers.map((b) => {
        const providerSpec = providers.find((p) => p.id === b.provider);
        return (
          <div key={b.id} className="glass p-4">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-white">{b.label}</span>
                  {b.isActive && <Pill tone="good">active</Pill>}
                </div>
                <div className="mt-0.5 text-[11.5px] text-white/40">{providerSpec?.name ?? b.provider} · {b.provider}</div>
              </div>
              <Pill tone={b.status === "connected" ? "good" : b.status === "error" ? "bad" : "warn"}>{b.status}</Pill>
            </div>

            {b.lastError && (
              <div className="mb-2 rounded-xl border border-ruby-500/25 bg-ruby-500/8 px-3 py-2 text-[11.5px] leading-relaxed text-ruby-400">{b.lastError}</div>
            )}

            <Row label="Credential fingerprint" value={b.credentialFingerprint} hint="Secrets are encrypted and never displayed" />

            {accounts[b.id]?.length ? (
              accounts[b.id]!.map((a) => (
                <div key={a.id} className="flex items-center justify-between border-b border-white/6 py-2.5 last:border-0">
                  <div>
                    <div className="text-[12.5px] text-white/80">
                      {a.account_type === "real" ? "Real" : "Demo"} · {a.account_id}
                    </div>
                    <div className="text-[11px] text-white/35">{a.loginid ?? "—"} · {a.currency}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="mono-num text-[12.5px] text-white">{a.balance === null ? "—" : money(a.balance)}</span>
                    {a.is_active ? (
                      <Pill tone="good">selected</Pill>
                    ) : (
                      <button
                        className="chip"
                        onClick={() =>
                          void (async () => {
                            try {
                              await api.post(`/api/accounts/${a.id}/activate`);
                              app.notify(`Account ${a.account_id} selected.`, "good");
                              await app.refresh();
                              await loadAccounts(b.id);
                            } catch (err) {
                              app.notify((err as Error).message, "bad");
                            }
                          })()
                        }
                      >
                        select
                      </button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="py-2 text-[11.5px] text-white/35">No accounts reported by this broker.</div>
            )}

            <div className="mt-3 flex gap-2">
              <button className="btn-ghost flex-1 !py-2.5 text-[13px]" onClick={() => void verify(b.id)} disabled={busy}>
                Verify
              </button>
              {!b.isActive && (
                <button
                  className="btn-ghost flex-1 !py-2.5 text-[13px]"
                  onClick={() =>
                    void (async () => {
                      try {
                        await api.post(`/api/brokers/${b.id}/activate`);
                        app.notify(`${b.label} is now the active broker.`, "good");
                        await app.refresh();
                      } catch (err) {
                        app.notify((err as Error).message, "bad");
                      }
                    })()
                  }
                >
                  Make active
                </button>
              )}
              <button className="btn-ghost !py-2.5 !px-3 text-[13px] text-ruby-400" onClick={() => setConfirmDelete(b.id)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove this broker?"
        body="The stored credentials are deleted. Open positions at the broker are not closed."
        confirmLabel="Remove broker"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const id = confirmDelete!;
          setConfirmDelete(null);
          void (async () => {
            try {
              await api.del(`/api/brokers/${id}`);
              app.notify("Broker removed.", "good");
              await app.refresh();
            } catch (err) {
              app.notify((err as Error).message, "bad");
            }
          })();
        }}
      />

      {!adding ? (
        <button className="btn-primary w-full" onClick={() => setAdding(true)}>Add a broker</button>
      ) : (
        <div className="glass p-4">
          <SectionTitle>Add a broker</SectionTitle>
          <div className="mb-3">
            <label className="label">Provider</label>
            <div className="flex flex-wrap gap-1.5">
              {providers.map((p) => (
                <button key={p.id} className={`chip ${provider === p.id ? "chip-active" : ""}`} onClick={() => setProvider(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {spec && (
            <div className="mb-3 rounded-2xl border tile px-3 py-2.5 text-[11.5px] leading-relaxed text-white/50">
              <div className="mb-1 flex items-center gap-2">
                <Pill tone={spec.implemented ? "good" : "warn"}>{spec.implemented ? "adapter ready" : "no adapter yet"}</Pill>
                {spec.fiveSecondExpiry && <Pill tone="good">5-second expiry</Pill>}
              </div>
              {spec.notes}
              <div className="mt-1.5 text-white/35">Requires: {spec.requires.join(", ") || "nothing"}</div>
              <div className="mt-1 truncate text-white/30">{spec.docsUrl}</div>
            </div>
          )}

          {!spec?.implemented && spec && (
            <div className="mb-3 rounded-2xl border border-amber-400/30 bg-amber-400/8 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-200/90">
              This provider has no working adapter yet, so it cannot be connected. It is listed so the requirement is visible rather than hidden. Implementing it needs: {spec.requires.join(", ")}.
            </div>
          )}

          {spec?.implemented && (
            <>
              <div className="mb-3">
                <label className="label">Label</label>
                <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={spec.name} />
              </div>
              {spec.requires.includes("token") && (
                <div className="mb-3">
                  <label className="label">API token</label>
                  <input className="field" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token" autoComplete="off" />
                </div>
              )}
              {spec.requires.includes("appId") && (
                <div className="mb-3">
                  <label className="label">App ID</label>
                  <input className="field" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="Registered application id" autoComplete="off" />
                </div>
              )}
            </>
          )}

          {result && (
            <div className={`mb-3 rounded-2xl border px-3 py-2.5 text-[11.5px] leading-relaxed ${result.verified ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-300" : "border-ruby-500/30 bg-ruby-500/8 text-ruby-400"}`}>
              {result.message}
            </div>
          )}

          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => { setAdding(false); setResult(null); }}>Cancel</button>
            <button className="btn-primary flex-1" onClick={() => void add()} disabled={busy || !spec?.implemented}>
              {busy ? <Spinner /> : "Connect & verify"}
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-white/35">
            Credentials are encrypted with AES-256-GCM before being stored and are never returned to the browser.
          </p>
        </div>
      )}
    </div>
  );
}

// --- Risk configuration -------------------------------------------------------

function RiskPanel({ app }: { app: AppState }) {
  const [draft, setDraft] = useState(app.risk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(app.risk), [app.risk]);

  if (!draft) return <EmptyState title="Loading risk configuration" body="Reading the current limits from the backend." />;

  const set = (key: keyof typeof draft, value: number | string[]) => setDraft({ ...draft, [key]: value });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ config: typeof draft }>("/api/risk", draft);
      app.setRisk(res.config);
      app.notify("Risk configuration saved. The backend now enforces these limits.", "good");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle>Risk limits</SectionTitle>
      <p className="mb-4 text-[11.5px] leading-relaxed text-white/40">
        These limits are enforced by the trading engine on every order, including orders placed by the engine itself. The engine cannot bypass them.
      </p>

      <div className="mb-4">
        <label className="label">Risk per trade (fraction of equity)</label>
        <input className="field mono-num" type="number" step="0.001" value={String(draft.riskPerTrade)} onChange={(e) => set("riskPerTrade", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">{(draft.riskPerTrade * 100).toFixed(2)}% of equity per trade.</p>
      </div>

      <div className="mb-4">
        <label className="label">Daily loss limit</label>
        <input className="field mono-num" type="number" step="1" value={String(draft.dailyLossLimit)} onChange={(e) => set("dailyLossLimit", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">New orders stop once realised loss reaches this amount for the day.</p>
      </div>

      <div className="mb-4">
        <label className="label">Maximum drawdown</label>
        <input className="field mono-num" type="number" step="0.01" value={String(draft.maxDrawdown)} onChange={(e) => set("maxDrawdown", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">{(draft.maxDrawdown * 100).toFixed(1)}% peak-to-trough before new orders stop.</p>
      </div>

      <div className="mb-4">
        <label className="label">Maximum exposure</label>
        <input className="field mono-num" type="number" step="10" value={String(draft.maxExposure)} onChange={(e) => set("maxExposure", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">Total open notional allowed across all positions.</p>
      </div>

      <div className="mb-4">
        <label className="label">Per-trade ceiling</label>
        <input className="field mono-num" type="number" step="10" value={String(draft.maxTradeAmount)} onChange={(e) => set("maxTradeAmount", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">No single order may exceed this amount, regardless of risk budget.</p>
      </div>

      <div className="mb-4">
        <label className="label">Maximum concurrent trades</label>
        <input className="field mono-num" type="number" step="1" value={String(draft.maxConcurrentTrades)} onChange={(e) => set("maxConcurrentTrades", Number(e.target.value))} />
      </div>

      <div className="mb-4">
        <label className="label">Consecutive-loss limit</label>
        <input className="field mono-num" type="number" step="1" value={String(draft.consecutiveLossLimit)} onChange={(e) => set("consecutiveLossLimit", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] text-white/35">After this many losses in a row, size is reduced further.</p>
      </div>

      <div className="mb-4">
        <label className="label">Loss-streak de-risk factor</label>
        <input className="field mono-num" type="number" step="0.05" value={String(draft.lossStreakDeRiskFactor)} onChange={(e) => set("lossStreakDeRiskFactor", Number(e.target.value))} />
        <p className="mt-1.5 text-[11px] leading-relaxed text-white/35">
          Size is multiplied by this factor per consecutive loss, compounding down. It must be at most 1, so size can never increase to recover a loss. Martingale is not possible.
        </p>
      </div>

      <div className="mb-4">
        <label className="label">Allowed instruments</label>
        <input
          className="field"
          value={draft.allowedSymbols.join(", ")}
          onChange={(e) => set("allowedSymbols", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          placeholder="Leave empty to allow any instrument"
        />
      </div>

      <div className="mb-4">
        <label className="label">Allowed strategies</label>
        <input
          className="field"
          value={draft.allowedStrategies.join(", ")}
          onChange={(e) => set("allowedStrategies", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          placeholder="Leave empty to allow any strategy"
        />
      </div>

      {error && <div className="mb-3 rounded-2xl border border-ruby-500/30 bg-ruby-500/8 px-3 py-2.5 text-[12px] text-ruby-400">{error}</div>}

      <button className="btn-primary w-full" onClick={() => void save()} disabled={busy}>
        {busy ? <Spinner /> : "Save risk configuration"}
      </button>
    </div>
  );
}

// --- Strategies ---------------------------------------------------------------

function StrategyPanel({ app }: { app: AppState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("trend_ema");
  const [builtins, setBuiltins] = useState<Array<{ id: string; name: string; description: string }>>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ builtins: Array<{ id: string; name: string; description: string }> }>("/api/strategies");
        setBuiltins(res.builtins);
      } catch {
        /* handled by the poll */
      }
    })();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      app.notify(message, "good");
      await app.refresh();
    } catch (err) {
      app.notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Active strategy</SectionTitle>
      <p className="text-[11.5px] leading-relaxed text-white/40">
        Changing the active strategy is your decision. PHIRST2 may recommend a change, but it never applies one to a running engine without your approval.
      </p>

      {app.strategies.map((s) => (
        <div key={s.id} className="glass p-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-white">{s.name}</span>
                {s.is_active && <Pill tone="good">active</Pill>}
                {s.builtin ? <Pill tone="neutral">built-in</Pill> : <Pill tone="gold">custom</Pill>}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/40">{s.description}</div>
            </div>
            <Switch checked={s.enabled} label={`Enable ${s.name}`} onChange={(v) => void act(`toggle-${s.id}`, () => api.patch(`/api/strategies/${encodeURIComponent(s.id)}`, { enabled: v }), v ? `${s.name} enabled.` : `${s.name} disabled.`)} />
          </div>

          {Object.keys(s.params).length > 0 && (
            <div className="mb-2 rounded-xl border border-white/8 bg-black/25 px-3 py-2">
              <div className="mono-num text-[11px] leading-relaxed text-white/45">{JSON.stringify(s.params)}</div>
            </div>
          )}

          <div className="flex gap-2">
            {!s.is_active && (
              <button className="btn-ghost flex-1 !py-2.5 text-[13px]" disabled={busy !== null || !s.enabled} onClick={() => void act(`activate-${s.id}`, () => api.post(`/api/strategies/${encodeURIComponent(s.id)}/activate`), `${s.name} is now active.`)}>
                {busy === `activate-${s.id}` ? <Spinner size={14} /> : "Activate"}
              </button>
            )}
            {!s.builtin && (
              <button className="btn-ghost !px-3 !py-2.5 text-[13px] text-ruby-400" disabled={busy !== null} onClick={() => void act(`delete-${s.id}`, () => api.del(`/api/strategies/${encodeURIComponent(s.id)}`), `${s.name} deleted.`)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      {!creating ? (
        <button className="btn-ghost w-full" onClick={() => setCreating(true)}>Create a custom strategy</button>
      ) : (
        <div className="glass p-4">
          <SectionTitle>New custom strategy</SectionTitle>
          <div className="mb-3">
            <label className="label">Based on</label>
            <div className="flex flex-wrap gap-1.5">
              {builtins.map((b) => (
                <button key={b.id} className={`chip ${templateId === b.id ? "chip-active" : ""}`} onClick={() => setTemplateId(b.id)}>
                  {b.name}
                </button>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <label className="label">Name</label>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="My strategy" />
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setCreating(false)}>Cancel</button>
            <button
              className="btn-primary flex-1"
              disabled={!name.trim() || busy !== null}
              onClick={() =>
                void act("create", async () => {
                  await api.post("/api/strategies", { name: name.trim(), templateId });
                  setName("");
                  setCreating(false);
                }, "Custom strategy created. It is disabled until you enable and activate it.")
              }
            >
              {busy === "create" ? <Spinner /> : "Create"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- PHIRST2 settings ---------------------------------------------------------

function PhirstPanel({ app, perf }: { app: AppState; perf: PerformanceReport | null }) {
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [identity, setIdentity] = useState<{ llm: { available: boolean; model: string | null } } | null>(null);

  const load = async () => {
    try {
      const [memRes, idRes] = await Promise.all([
        api.get<{ memory: MemoryRecord[] }>("/api/phirst/memory"),
        api.get<{ llm: { available: boolean; model: string | null } }>("/api/phirst/identity"),
      ]);
      setMemory(memRes.memory);
      setIdentity(idRes);
    } catch (err) {
      app.notify((err as Error).message, "bad");
    }
  };

  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!newMemory.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/phirst/memory", { content: newMemory.trim(), importance: 2 });
      setNewMemory("");
      await load();
      app.notify("Memory entry added.", "good");
    } catch (err) {
      app.notify((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Identity</SectionTitle>
      <div className="glass p-4">
        <Row label="Name" value="PHIRST2" />
        <Row label="User" value="BAELAY" />
        <Row label="Role" value="Private wealth manager" />
        <Row label="Temperament" value="Calm · Precise · Disciplined" />
      </div>

      <SectionTitle>Language model</SectionTitle>
      <div className="glass p-4">
        {identity ? (
          identity.llm.available ? (
            <>
              <Pill tone="good">available</Pill>
              <div className="mt-2 text-[12px] text-white/60">
                Model: <span className="mono-num">{identity.llm.model}</span>
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-white/40">
                Used for sentiment opinion, conversational replies and analysis. Time-sensitive decisions stay deterministic.
              </p>
            </>
          ) : (
            <>
              <Pill tone="warn">not configured</Pill>
              <p className="mt-2 text-[11.5px] leading-relaxed text-white/40">
                Set GEMINI_API_KEY on the server to enable AI opinion and conversational replies. Until then PHIRST2 reports measured facts only and never invents analysis.
              </p>
            </>
          )
        ) : (
          <Spinner />
        )}
      </div>

      <SectionTitle>Performance review</SectionTitle>
      <div className="glass p-4">
        {perf && perf.totalTrades >= 5 ? (
          <>
            <Row label="Settled trades" value={String(perf.totalTrades)} />
            <Row label="Profit factor" value={perf.profitFactor === null ? "—" : perf.profitFactor.toFixed(2)} />
            <Row label="Expectancy" value={signed(perf.expectancy)} tone={perf.expectancy >= 0 ? "good" : "bad"} />
            <p className="mt-3 text-[11.5px] leading-relaxed text-white/40">
              {perf.profitFactor !== null && perf.profitFactor < 1 && perf.expectancy < 0
                ? "PHIRST2 recommends reviewing this strategy. It is deteriorating by profit factor and expectancy. No change is applied without your approval."
                : "No strategy change is recommended at this sample size."}
            </p>
          </>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-white/40">
            A recommendation needs at least five settled trades. Statistics are not extrapolated from too little data.
          </p>
        )}
      </div>

      <SectionTitle>Memory</SectionTitle>
      <p className="text-[11.5px] leading-relaxed text-white/40">
        Durable notes PHIRST2 keeps about your preferences. Broker secrets are never stored here.
      </p>
      <div className="mb-2 flex gap-2">
        <input className="field flex-1" value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="Add a note" onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button className="btn-primary !px-4" onClick={() => void add()} disabled={busy || !newMemory.trim()}>{busy ? <Spinner /> : "Add"}</button>
      </div>

      {memory.length === 0 ? (
        <EmptyState title="No stored memory" body="Notes you add here are available to PHIRST2 when it answers." />
      ) : (
        memory.map((m) => (
          <div key={m.id} className="mb-2 flex items-start justify-between gap-3 rounded-2xl border tile px-3.5 py-2.5">
            <div>
              <div className="text-[12.5px] leading-relaxed text-white/80">{m.content}</div>
              <div className="mt-1 text-[10.5px] text-white/30">importance {m.importance} · {m.source}</div>
            </div>
            <button
              className="shrink-0 text-[11.5px] text-ruby-400"
              onClick={() =>
                void (async () => {
                  try {
                    await api.del(`/api/phirst/memory/${m.id}`);
                    await load();
                  } catch (err) {
                    app.notify((err as Error).message, "bad");
                  }
                })()
              }
            >
              Delete
            </button>
          </div>
        ))
      )}

      {memory.length > 0 && (
        <button className="btn-ghost w-full !text-ruby-400" onClick={() => setConfirmPurge(true)}>Delete all memory</button>
      )}

      <ConfirmDialog
        open={confirmPurge}
        title="Delete all PHIRST2 memory?"
        body="Every stored note is removed permanently. This cannot be undone."
        confirmLabel="Delete all"
        onCancel={() => setConfirmPurge(false)}
        onConfirm={() => {
          setConfirmPurge(false);
          void (async () => {
            try {
              await api.post("/api/phirst/memory/purge");
              await load();
              app.notify("All memory deleted.", "good");
            } catch (err) {
              app.notify((err as Error).message, "bad");
            }
          })();
        }}
      />
    </div>
  );
}

// --- Voice & avatar -----------------------------------------------------------

function VoicePanel({ app }: { app: AppState }) {
  const [draft, setDraft] = useState<VoiceSettings | null>(app.voice);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);

  useEffect(() => setDraft(app.voice), [app.voice]);
  if (!draft) return <EmptyState title="Loading voice settings" body="Reading the saved voice configuration." />;

  const set = <K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]) => setDraft({ ...draft, [key]: value });

  const save = async (next?: VoiceSettings) => {
    const payload = next ?? draft;
    setBusy(true);
    try {
      const res = await api.put<{ voice: VoiceSettings }>("/api/phirst/voice", payload);
      app.setVoice(res.voice);
      app.notify("Voice settings saved.", "good");
    } catch (err) {
      app.notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const test = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setProbe("Speech synthesis is not available in this browser.");
      return;
    }
    const voices = window.speechSynthesis.getVoices();
    const japanese = voices.filter((v) => v.lang.toLowerCase().startsWith("ja"));
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("PHIRST2 online. Calm in execution, precise in judgement.");
    const match = japanese.find((v) => (draft.voice === "female" ? /kyoko|nanami|female/i.test(v.name) : /otoya|hattori|male/i.test(v.name))) ?? japanese[0];
    if (match) u.voice = match;
    u.rate = draft.rate;
    u.pitch = draft.pitch;
    window.speechSynthesis.speak(u);
    setProbe(
      `${voices.length} voice(s) available on this device. ` +
        (japanese.length
          ? `Using ${match?.name ?? "a Japanese voice"} (${match?.lang}).`
          : "No Japanese voice is installed, so a default voice is used. Install a Japanese voice in your operating system to hear the Japanese-inspired option."),
    );
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Voice</SectionTitle>
      <div className="glass p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Spoken replies</div>
            <div className="text-[11px] text-white/35">PHIRST2 speaks its answers aloud</div>
          </div>
          <Switch checked={draft.enabled} label="Spoken replies" onChange={(v) => void save({ ...draft, enabled: v })} />
        </div>

        <div className="mb-4">
          <label className="label">Voice</label>
          <div className="flex gap-1.5">
            {(["female", "male"] as const).map((v) => (
              <button key={v} className={`chip ${draft.voice === v ? "chip-active" : ""}`} onClick={() => void save({ ...draft, voice: v })}>
                {v === "female" ? "Female" : "Male"}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="label">Accent</label>
          <div className="flex flex-wrap gap-1.5">
            {["ja-JP-inspired", "en-US", "en-GB"].map((a) => (
              <button key={a} className={`chip ${draft.accent === a ? "chip-active" : ""}`} onClick={() => void save({ ...draft, accent: a })}>
                {a}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/35">
            The device provides the voices. A Japanese-inspired voice is used when a Japanese voice is installed; otherwise the closest available voice is used and reported honestly.
          </p>
        </div>

        <div className="mb-4">
          <label className="label">Rate · {draft.rate.toFixed(2)}</label>
          <input type="range" min="0.5" max="2" step="0.05" value={draft.rate} onChange={(e) => set("rate", Number(e.target.value))} onPointerUp={() => void save()} className="w-full accent-emerald-500" />
        </div>

        <div className="mb-4">
          <label className="label">Pitch · {draft.pitch.toFixed(2)}</label>
          <input type="range" min="0" max="2" step="0.05" value={draft.pitch} onChange={(e) => set("pitch", Number(e.target.value))} onPointerUp={() => void save()} className="w-full accent-emerald-500" />
        </div>

        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Push to talk</div>
            <div className="text-[11px] text-white/35">Microphone opens only while held</div>
          </div>
          <Switch checked={draft.pushToTalk} label="Push to talk" onChange={(v) => void save({ ...draft, pushToTalk: v, handsFree: v ? false : draft.handsFree })} />
        </div>

        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Hands-free listening</div>
            <div className="text-[11px] text-white/35">Keeps the microphone open between turns</div>
          </div>
          <Switch checked={draft.handsFree} label="Hands-free" onChange={(v) => void save({ ...draft, handsFree: v, pushToTalk: v ? false : draft.pushToTalk })} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] text-white/85">Speak alerts aloud</div>
            <div className="text-[11px] text-white/35">Critical and warning notifications are spoken</div>
          </div>
          <Switch checked={draft.autoSpeakAlerts} label="Speak alerts" onChange={(v) => void save({ ...draft, autoSpeakAlerts: v })} />
        </div>
      </div>

      <SectionTitle>Avatar</SectionTitle>
      <div className="glass p-4">
        <Row label="Style" value="Japanese-inspired digital human" />
        <Row label="Rendering" value="Procedural canvas" hint="Drawn per frame; no image or video asset" />
        <Row label="Lip sync" value="Viseme timeline" hint="Follows the speech engine's word-boundary events" />
        <Row label="Motion" value="State-driven" hint="Breathing, blink, saccades, head sway, listening pulse" />
        <Row label="Placement" value="Hidden until activated" hint="Floating button, opens the conversation" />
      </div>

      <button className="btn-ghost w-full" onClick={test}>Test voice on this device</button>
      {probe && <div className="rounded-2xl border tile px-3.5 py-3 text-[11.5px] leading-relaxed text-white/60">{probe}</div>}
      {busy && <div className="text-center text-[11px] text-white/35">Saving…</div>}
    </div>
  );
}

// --- Notifications ------------------------------------------------------------

function NotificationPanel({ app }: { app: AppState }) {
  const [all, setAll] = useState<Array<{ id: string; severity: string; title: string; body: string; category: string; read_at: string | null; created_at: string }>>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.get<{ notifications: typeof all }>("/api/notifications");
      setAll(res.notifications);
    } catch (err) {
      app.notify((err as Error).message, "bad");
    }
  };
  useEffect(() => { void load(); }, []);

  const toneFor = (s: string) => (s === "critical" ? "bad" : s === "warning" ? "warn" : "neutral");

  return (
    <div className="space-y-4">
      <SectionTitle
        action={
          all.some((n) => !n.read_at) ? (
            <button
              className="text-[11.5px] text-white/50"
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await api.post("/api/notifications/read-all");
                    await load();
                    await app.refresh();
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Mark all read
            </button>
          ) : undefined
        }
      >
        Notifications
      </SectionTitle>

      <p className="text-[11.5px] leading-relaxed text-white/40">
        Alerts are generated from real events: risk vetoes, connectivity loss, execution problems and strategy deterioration. Nothing here is synthetic.
      </p>

      {all.length === 0 ? (
        <EmptyState title="No notifications" body="Alerts appear here when a real trigger fires." />
      ) : (
        all.map((n) => (
          <div key={n.id} className={`mb-2 rounded-2xl border px-3.5 py-3 ${n.read_at ? "border-white/6 bg-white/[0.015]" : "tile"}`}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Pill tone={toneFor(n.severity)}>{n.severity}</Pill>
              <span className="text-[10.5px] text-white/30">{new Date(n.created_at).toLocaleString()}</span>
            </div>
            <div className="text-[12.5px] font-medium text-white/90">{n.title}</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/50">{n.body}</div>
            {!n.read_at && (
              <button
                className="mt-2 text-[11px] text-emerald-400"
                onClick={() =>
                  void (async () => {
                    await api.post(`/api/notifications/${n.id}/read`);
                    await load();
                    await app.refresh();
                  })()
                }
              >
                Mark read
              </button>
            )}
          </div>
        ))
      )}
      {busy && <div className="text-center text-[11px] text-white/35">Working…</div>}
    </div>
  );
}

// --- Telegram -----------------------------------------------------------------

function TelegramPanel({ app }: { app: AppState }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(await api.get<TelegramStatus>("/api/telegram/status"));
    } catch (err) {
      app.notify((err as Error).message, "bad");
    }
  };
  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      app.notify(msg, "good");
      await load();
    } catch (err) {
      app.notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionTitle>Telegram bot</SectionTitle>

      {status && !status.configured && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/8 px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-200/90">
          TELEGRAM_BOT_TOKEN is not configured on the server. Create a bot with BotFather, set the token in the server environment and restart the API. Remote commands are disabled until then.
        </div>
      )}

      {status?.configured && (
        <div className="glass p-4">
          <Row label="Bot" value={status.botUsername ? `@${status.botUsername}` : "connected"} />
          <Row label="Polling" value={status.running ? "active" : "stopped"} tone={status.running ? "good" : "bad"} />
          <Row label="Updates processed" value={String(status.updatesProcessed)} />
          {status.lastError && <Row label="Last error" value={status.lastError} tone="bad" />}
        </div>
      )}

      <SectionTitle>Link a chat</SectionTitle>
      <p className="text-[11.5px] leading-relaxed text-white/40">
        Generate a one-time code and send it to the bot. A chat cannot control the engine until it is linked and granted permissions.
      </p>

      <button className="btn-primary w-full" disabled={busy || !status?.configured} onClick={() => void act(async () => { const res = await api.post<{ code: string }>("/api/telegram/link-code"); setCode(res.code); }, "Link code generated. Send it to the bot within ten minutes.")}>
        {busy ? <Spinner /> : "Generate link code"}
      </button>

      {code && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/8 px-4 py-3">
          <div className="text-[11px] uppercase text-white/50" style={{ letterSpacing: "0.12em" }}>Send this to the bot</div>
          <div className="mono-num mt-1.5 select-all text-[19px] font-semibold text-emerald-300">/start {code}</div>
          <div className="mt-1.5 text-[11px] text-white/40">Expires in ten minutes and works once.</div>
        </div>
      )}

      <SectionTitle>Linked chats</SectionTitle>
      {status?.links.length === 0 ? (
        <EmptyState title="No linked chats" body="Once a chat is linked, its permissions appear here for you to adjust." />
      ) : (
        status?.links.map((l) => (
          <div key={l.chatId} className="glass mb-2 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="mono-num text-[13px] text-white">{l.chatId}</span>
              <button className="text-[11.5px] text-ruby-400" disabled={busy} onClick={() => void act(() => api.del(`/api/telegram/links/${l.chatId}`), "Chat unlinked.")}>
                Unlink
              </button>
            </div>
            <div className="mb-2 text-[11px] uppercase text-white/40" style={{ letterSpacing: "0.1em" }}>Permissions</div>
            <div className="flex flex-wrap gap-1.5">
              {(status?.availablePermissions ?? []).map((p) => {
                const on = l.permissions.includes(p);
                return (
                  <button
                    key={p}
                    className={`chip ${on ? "chip-active" : ""}`}
                    disabled={busy}
                    onClick={() => {
                      const next = on ? l.permissions.filter((x) => x !== p) : [...l.permissions, p];
                      void act(() => api.put(`/api/telegram/links/${l.chatId}`, { permissions: next }), `Permissions updated for ${l.chatId}.`);
                    }}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-white/35">
              Trade and emergency permissions are not granted by default. Grant them only to a chat you control.
            </p>
          </div>
        ))
      )}

      <button className="btn-ghost w-full" disabled={busy || !status?.configured || status.links.length === 0} onClick={() => void act(() => api.post("/api/telegram/test"), "Test message sent.")}>
        Send a test message
      </button>
    </div>
  );
}

// --- Security & memory --------------------------------------------------------

function SecurityPanel({ app }: { app: AppState }) {
  const [audit, setAudit] = useState<Array<{ id: string; actor: string; action: string; target: string | null; at: string }>>([]);
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const changePassword = async () => {
    setPwMessage(null);
    if (newPassword.length < 12) {
      setPwMessage({ tone: "bad", text: "New password must be at least 12 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMessage({ tone: "bad", text: "New passwords do not match." });
      return;
    }
    setPwBusy(true);
    try {
      const res = await api.post<{ sessionsRevoked: number }>("/api/auth/change-password", { currentPassword, newPassword });
      setPwMessage({
        tone: "good",
        text: `Password changed. ${res.sessionsRevoked} other session(s) were signed out.`,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPwMessage({ tone: "bad", text: err instanceof ApiFailure ? err.message : (err as Error).message });
    } finally {
      setPwBusy(false);
    }
  };

  const load = async () => {
    try {
      const [auditRes, memRes] = await Promise.all([
        api.get<{ entries: typeof audit }>("/api/audit?limit=80"),
        api.get<{ memory: MemoryRecord[] }>("/api/phirst/memory"),
      ]);
      setAudit(auditRes.entries);
      setMemory(memRes.memory);
    } catch (err) {
      app.notify((err as Error).message, "bad");
    }
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="space-y-4">
      <SectionTitle>Security posture</SectionTitle>
      <div className="glass p-4">
        <Row label="Credential storage" value="AES-256-GCM" hint="Envelope encrypted; never returned to the browser" />
        <Row label="Session cookie" value="HttpOnly · SameSite=Lax" hint="Secure flag enabled in production" />
        <Row label="Password hashing" value="scrypt" />
        <Row label="Live trading" value="Requires confirmation phrase" />
        <Row label="Emergency stop" value="Persistent, backend-enforced" />
        <Row label="AI memory" value="Broker secrets excluded" />
      </div>

      <SectionTitle>Owner password</SectionTitle>
      <div className="glass p-4">
        <label className="label">Current password</label>
        <input
          type="password"
          className="field mb-3"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <label className="label">New password</label>
        <input
          type="password"
          className="field mb-3"
          autoComplete="new-password"
          placeholder="At least 12 characters"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <label className="label">Confirm new password</label>
        <input
          type="password"
          className="field mb-3"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        <button
          className="btn-ghost w-full"
          disabled={pwBusy || !currentPassword || !newPassword || !confirmPassword}
          onClick={() => void changePassword()}
        >
          {pwBusy ? <Spinner /> : "Change password"}
        </button>
        {pwMessage && (
          <div
            className={`mt-3 rounded-2xl border px-3.5 py-2.5 text-[12px] leading-relaxed ${
              pwMessage.tone === "good"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                : "border-ruby-500/35 bg-ruby-500/10 text-ruby-400"
            }`}
          >
            {pwMessage.text}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          Changing the password signs out every other device. This session stays active.
        </p>
      </div>

      <SectionTitle>AI memory</SectionTitle>
      {memory.length === 0 ? (
        <EmptyState title="No stored memory" body="PHIRST2 holds no notes about you yet." />
      ) : (
        <>
          <p className="text-[11.5px] text-white/40">{memory.length} note(s) stored.</p>
          <button className="btn-ghost w-full !text-ruby-400" onClick={() => setConfirmPurge(true)}>Delete all AI memory</button>
        </>
      )}

      <ConfirmDialog
        open={confirmPurge}
        title="Delete all AI memory?"
        body="Every stored note is removed permanently. This cannot be undone."
        confirmLabel="Delete all"
        onCancel={() => setConfirmPurge(false)}
        onConfirm={() => {
          setConfirmPurge(false);
          void (async () => {
            try {
              await api.post("/api/phirst/memory/purge");
              await load();
              app.notify("All memory deleted.", "good");
            } catch (err) {
              app.notify((err as Error).message, "bad");
            }
          })();
        }}
      />

      <SectionTitle>Audit log</SectionTitle>
      {audit.length === 0 ? (
        <EmptyState title="No audit entries" body="Significant actions are recorded here." />
      ) : (
        <div className="glass p-4">
          {audit.map((a) => (
            <Row key={a.id} label={a.action} hint={`${a.actor}${a.target ? ` · ${a.target}` : ""} · ${new Date(a.at).toLocaleString()}`} value="" />
          ))}
        </div>
      )}
    </div>
  );
}

// --- System -------------------------------------------------------------------

function SystemPanel({ app, onRefresh }: { app: AppState; onRefresh: () => Promise<void> }) {
  const [health, setHealth] = useState<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> } | null>(null);
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [h, d] = await Promise.all([
        api.get<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }>("/api/health"),
        api.get<Record<string, unknown>>("/api/diagnostics"),
      ]);
      setHealth(h);
      setDiag(d);
    } catch (err) {
      app.notify((err as Error).message, "bad");
    }
  };
  useEffect(() => { void load(); }, []);

  const recon = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ result: { brokerPositions: number; matched: number; resolved: number; unresolved: string[] } | null }>("/api/engine/reconcile");
      app.notify(
        res.result
          ? `Reconciled: ${res.result.brokerPositions} broker position(s), ${res.result.matched} matched, ${res.result.resolved} resolved, ${res.result.unresolved.length} unresolved.`
          : "No active broker to reconcile.",
        res.result?.unresolved.length ? "warn" : "good",
      );
      await onRefresh();
      await load();
    } catch (err) {
      app.notify((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const telegram = (diag?.telegram ?? null) as { configured?: boolean; running?: boolean } | null;
  const llm = (diag?.llm ?? null) as { available?: boolean; model?: string } | null;

  return (
    <div className="space-y-4">
      <SectionTitle>Health</SectionTitle>
      <div className="glass p-4">
        {health ? (
          Object.entries(health.checks).map(([key, value]) => (
            <Row
              key={key}
              label={titleCase(key)}
              value={value.ok ? "ok" : "degraded"}
              hint={value.detail}
              tone={value.ok ? "good" : "bad"}
            />
          ))
        ) : (
          <Spinner />
        )}
      </div>

      <SectionTitle>Diagnostics</SectionTitle>
      <div className="glass p-4">
        <Row label="Environment" value={String(diag?.env ?? "—")} />
        <Row label="Language model" value={llm?.available ? String(llm.model) : "not configured"} tone={llm?.available ? "good" : "bad"} />
        <Row label="Telegram" value={telegram?.configured ? (telegram.running ? "active" : "configured, stopped") : "not configured"} tone={telegram?.configured ? "good" : "bad"} />
        <Row label="Active strategy" value={app.engine?.activeStrategyId ?? "—"} />
        <Row label="Instrument" value={app.engine?.symbol ?? "—"} />
        <Row label="Consecutive losses" value={String(app.engine?.consecutiveLosses ?? 0)} />
        <Row label="Drawdown" value={app.engine ? `${(app.engine.drawdown * 100).toFixed(2)}%` : "—"} tone={(app.engine?.drawdown ?? 0) > 0.1 ? "bad" : undefined} />
      </div>

      <SectionTitle>Reconciliation</SectionTitle>
      <p className="text-[11.5px] leading-relaxed text-white/40">
        Compare the engine's record with the broker's actual positions and open orders. This never resubmits an order.
      </p>
      <button className="btn-ghost w-full" onClick={() => void recon()} disabled={busy}>
        {busy ? <Spinner /> : "Run reconciliation now"}
      </button>

      <SectionTitle>Deployment</SectionTitle>
      <div className="glass p-4">
        <Row label="Architecture" value="Separate API and web processes" />
        <Row label="Database" value="PostgreSQL, persistent" />
        <Row label="Engine" value="Runs independently of the frontend" />
        <Row label="Recovery" value="Restart resumes paused, never silently running" />
        <Row label="Backups" value="See docs/DEPLOYMENT.md" />
      </div>
    </div>
  );
}
