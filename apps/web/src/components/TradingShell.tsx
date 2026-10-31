"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, type AvatarState } from "./Avatar";
import { Chart, type ChartStyle, type IndicatorKey } from "./Chart";
import { Card, ConfirmDialog, Dot, EmptyState, Pill, Row, SectionTitle, Sheet, Spinner, Toast } from "./ui";
import { api, ApiFailure, type Candle, type ChatReply, type EngineStatus, type OrderRecord, type PerformanceReport, type PositionRecord } from "@/lib/api";
import { useAppState } from "@/lib/store";
import { useVoice } from "@/lib/voice";
import { sound } from "@/lib/sound";
import { Panels } from "./Panels";
import { OrderSheet, AssetSheet, PhirstConsole } from "./Sheets";
import { AssetsScreen, DiscoverScreen, HistoryScreen, NotificationsScreen, PositionsScreen, ProfileScreen, SupportScreen } from "./Screens";
import { CommunityScreen, MembersScreen, MessagingScreen } from "./Community";
import { AdminScreen } from "./Admin";
import { useSession } from "@/lib/session";
import { money, signed, timeAgo, statusTone } from "@/lib/format";

const TIMEFRAME_LABELS: Record<number, string> = {
  5: "5s", 15: "15s", 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d",
};

const INDICATORS: Array<{ key: IndicatorKey; label: string }> = [
  { key: "ema", label: "EMA" },
  { key: "sma", label: "SMA" },
  { key: "bollinger", label: "BB" },
  { key: "rsi", label: "RSI" },
];

export type NavKey = "trade" | "positions" | "discover" | "assets" | "more";
export type MoreKey =
  | "hub"
  | "history"
  | "notifications"
  | "community"
  | "messages"
  | "members"
  | "profile"
  | "support"
  | "admin";

const MORE_LABELS: Record<Exclude<MoreKey, "hub">, string> = {
  history: "Trade history",
  notifications: "Notifications",
  community: "Community",
  messages: "Messages",
  members: "Members",
  profile: "Profile and security",
  support: "Help and diagnostics",
  admin: "Owner dashboard",
};

export function TradingShell() {
  const app = useAppState(true);
  const { isOwner, isModerator } = useSession();
  const { engine, risk, notifications, voice, connected, refresh, notify, toasts, dismissToast, prefs } = app;

  const [tab, setTab] = useState<"trade" | "positions" | "history">("trade");
  // Primary navigation. `more` is the hub that leads to the secondary screens.
  const [nav, setNav] = useState<NavKey>("trade");
  const [more, setMore] = useState<MoreKey | null>(null);
  const [timeframe, setTimeframe] = useState(60);
  const [indicators, setIndicators] = useState<IndicatorKey[]>(["ema", "rsi"]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [amount, setAmount] = useState("10");
  const [duration, setDuration] = useState("60");
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [orderSheet, setOrderSheet] = useState<"buy" | "sell" | null>(null);
  const [assetSheetOpen, setAssetSheetOpen] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");
  const [perf, setPerf] = useState<PerformanceReport | null>(null);

  const symbol = engine?.symbol ?? "R_100";
  const symbolName = useMemo(() => app.instruments.find((i) => i.symbol === symbol)?.name ?? symbol, [app.instruments, symbol]);
  const price = engine?.lastPrice ?? (candles.length ? candles[candles.length - 1]!.close : null);
  const prevClose = candles.length > 1 ? candles[candles.length - 2]!.close : null;
  const change = price !== null && prevClose !== null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;

  // Preferences drive real behaviour. Until they load, sensible defaults apply.
  const chartStyle: ChartStyle = prefs?.chartStyle ?? "candles";
  const chartGrid = prefs?.chartGrid ?? true;
  const chartHeight = prefs?.chartHeight ?? 320;
  const timeframes = prefs?.timeframes?.length ? prefs.timeframes : [60, 300, 900, 3600, 14400, 86400];
  const tiles = prefs?.dashboardTiles ?? ["equity", "pnl", "open"];
  const soundOn = prefs?.soundEnabled ?? true;

  // Apply saved defaults once, when preferences first arrive.
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (!prefs || appliedDefaults.current) return;
    appliedDefaults.current = true;
    setAmount(String(prefs.defaultAmount));
    setDuration(String(prefs.defaultDurationSec));
    setIndicators(prefs.defaultIndicators as IndicatorKey[]);
    if (prefs.timeframes.length && !prefs.timeframes.includes(60)) setTimeframe(prefs.timeframes[0]!);
    sound.setVolume(prefs.soundVolume);
    sound.setMuted(!prefs.soundEnabled);
  }, [prefs]);

  // Keep the audio engine in step with the preference without re-running the setup above.
  useEffect(() => {
    if (!prefs) return;
    sound.setMuted(!prefs.soundEnabled);
    sound.setVolume(prefs.soundVolume);
  }, [prefs?.soundEnabled, prefs?.soundVolume, prefs]);

  const loadChart = useCallback(
    async (sym: string, tf: number) => {
      setChartLoading(true);
      try {
        const res = await api.get<{ candles: Candle[] }>(`/api/market/candles?symbol=${encodeURIComponent(sym)}&granularity=${tf}&count=180`);
        setCandles(res.candles);
      } catch (err) {
        notify(`Chart data unavailable: ${(err as Error).message}`, "bad");
        setCandles([]);
      } finally {
        setChartLoading(false);
      }
    },
    [notify],
  );

  const loadTradingData = useCallback(async () => {
    try {
      const [orderRes, posRes, perfRes] = await Promise.all([
        api.get<{ orders: OrderRecord[] }>("/api/orders?limit=60"),
        api.get<{ positions: PositionRecord[] }>("/api/positions"),
        api.get<PerformanceReport>("/api/reports/performance"),
      ]);
      setOrders(orderRes.orders);
      setPositions(posRes.positions);
      setPerf(perfRes);
    } catch {
      /* the poll will retry */
    }
  }, []);

  const instrumentsLoaded = useRef(false);
  useEffect(() => {
    if (connected && !instrumentsLoaded.current) {
      instrumentsLoaded.current = true;
      void app.loadInstruments();
    }
  }, [connected, app]);

  useEffect(() => {
    if (!connected) return;
    void loadChart(symbol, timeframe);
  }, [connected, symbol, timeframe, loadChart]);

  useEffect(() => {
    if (!connected) return;
    void loadTradingData();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadTradingData();
        void loadChart(symbol, timeframe);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [connected, loadTradingData, loadChart, symbol, timeframe]);

  const voiceSettings = voice ?? {
    enabled: true, voice: "male" as const, accent: "ja-JP-inspired", rate: 0.95, pitch: 0.85,
    pushToTalk: true, handsFree: false, autoSpeakAlerts: true,
  };
  const v = useVoice(voiceSettings);
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [chatLog, setChatLog] = useState<Array<{ role: "user" | "phirst"; text: string; source?: string; at: string }>>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [urgency, setUrgency] = useState<"normal" | "attention" | "critical">("normal");
  const announcedAlerts = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (v.speaking) setAvatarState("speaking");
    else if (v.listening) setAvatarState("listening");
    else if (chatBusy) setAvatarState("thinking");
    else if (urgency === "critical") setAvatarState("alert");
    else setAvatarState("idle");
  }, [v.speaking, v.listening, chatBusy, urgency]);

  const askPhirst = useCallback(
    async (message: string) => {
      if (!message.trim()) return;
      setChatLog((prev) => [...prev, { role: "user", text: message, at: new Date().toISOString() }]);
      setChatBusy(true);
      try {
        const res = await api.post<ChatReply>("/api/phirst/chat", { message });
        setChatLog((prev) => [...prev, { role: "phirst", text: res.reply, source: res.source, at: new Date().toISOString() }]);
        setUrgency(res.urgency);
        if (res.urgency === "critical") sound.play("critical");
        v.speak(res.reply);
        if (res.source === "fallback" && res.error) {
          notify(`PHIRST2 language model unavailable (${res.error}). Reporting measured facts only.`, "warn");
        }
      } catch (err) {
        notify(`PHIRST2 could not answer: ${(err as Error).message}`, "bad");
      } finally {
        setChatBusy(false);
      }
    },
    [notify, v],
  );

  useEffect(() => {
    if (!voiceSettings.autoSpeakAlerts || !voiceSettings.enabled) return;
    for (const n of notifications) {
      if (announcedAlerts.current.has(n.id)) continue;
      announcedAlerts.current.add(n.id);
      if (n.severity === "critical" || n.severity === "warning") {
        v.speak(`${n.title}. ${n.body}`);
        setUrgency(n.severity === "critical" ? "critical" : "attention");
        sound.play(n.severity === "critical" ? "critical" : "alert");
      }
    }
  }, [notifications, voiceSettings.autoSpeakAlerts, voiceSettings.enabled, v]);

  useEffect(() => {
    if (!voiceSettings.handsFree || !voiceSettings.enabled || !connected) return;
    if (v.listening || v.speaking || chatBusy) return;
    const id = setTimeout(() => v.startListening((text) => void askPhirst(text)), 900);
    return () => clearTimeout(id);
  }, [voiceSettings.handsFree, voiceSettings.enabled, connected, v, chatBusy, askPhirst]);

  const run = async (key: string, fn: () => Promise<unknown>, successMsg?: string) => {
    setBusy(key);
    try {
      await fn();
      if (successMsg) notify(successMsg, "good");
      await refresh();
      await loadTradingData();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const placeOrder = (side: "buy" | "sell") =>
    run(`order-${side}`, async () => {
      const amountNum = Number(amount);
      const durationNum = Number(duration);
      if (!Number.isFinite(amountNum) || amountNum <= 0) throw new ApiFailure(400, "Enter a trade amount greater than 0.");
      if (!Number.isInteger(durationNum) || durationNum <= 0) throw new ApiFailure(400, "Enter a duration in whole seconds.");
      const res = await api.post<{ ok: boolean; message: string }>("/api/orders", { side, amount: amountNum, durationSec: durationNum, symbol });
      notify(`${side === "buy" ? "Buy" : "Sell"} order: ${res.message}`, "good");
      setOrderSheet(null);
    });

  const engineAction = (action: string, label: string, body?: unknown) =>
    run(`engine-${action}`, async () => {
      const res = await api.post<{ ok?: boolean; message?: string }>(`/api/engine/${action}`, body ?? {});
      notify(res.message ?? label, res.ok === false ? "bad" : "good");
    });

  // A single tap feedback helper: only fires when sound is genuinely on.
  const tap = useCallback(() => {
    if (soundOn) sound.play("tap");
  }, [soundOn]);

  const kpiTiles: Array<{ key: string; label: string; value: React.ReactNode; tone?: "good" | "bad" }> = ([
    { key: "equity", label: "Equity", value: money(engine?.equity) },
    { key: "balance", label: "Balance", value: money(engine?.balance) },
    {
      key: "pnl",
      label: "P&L today",
      value: engine ? signed(engine.dailyPnl) : "—",
      tone: (engine?.dailyPnl ?? 0) >= 0 ? "good" : "bad",
    },
    { key: "open", label: "Open", value: engine?.openTrades ?? 0 },
    {
      key: "drawdown",
      label: "Drawdown",
      value: engine ? `${(engine.drawdown * 100).toFixed(1)}%` : "—",
      tone: (engine?.drawdown ?? 0) > 0.1 ? "bad" : undefined,
    },
    {
      key: "winrate",
      label: "Win rate",
      value: perf && perf.totalTrades > 0 ? `${(perf.winRate * 100).toFixed(0)}%` : "—",
    },
  ] as Array<{ key: string; label: string; value: React.ReactNode; tone?: "good" | "bad" }>).filter((t) => tiles.includes(t.key));

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1180px] flex-col pb-24 lg:pb-10">
      {toasts.map((t) => (
        <Toast key={t.id} message={t.text} tone={t.tone} onDone={() => dismissToast(t.id)} />
      ))}

      <header className="safe-top sticky top-0 z-40 border-b border-white/6 bg-ink-950/85 px-4 pb-3 backdrop-blur-xl">
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-champagne-500/25 bg-champagne-500/10">
              <span className="font-display text-[15px] font-semibold text-champagne-300">W</span>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-display text-[15px] tracking-[0.14em] text-white">WEIN</span>
                {engine && (
                  <Pill tone={statusTone(engine.state)}>
                    <Dot tone={statusTone(engine.state)} pulse={engine.state === "running"} />
                    {engine.state}
                  </Pill>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-white/40">
                <span className={engine?.mode === "live" ? "font-semibold text-ruby-400" : ""}>{engine?.mode === "live" ? "LIVE" : "PAPER"}</span>
                <span>·</span>
                <span className="truncate">{engine?.brokerName ?? "no broker"}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!connected && <Pill tone="bad"><Dot tone="bad" pulse />offline</Pill>}
            <button
              onClick={() => { tap(); setPanelsOpen(true); }}
              className="rounded-full border border-white/12 bg-white/5 p-2 active:scale-95"
              aria-label="Open controls"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="text-white/80">
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className={`mt-3 grid gap-2 ${kpiTiles.length >= 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
          {kpiTiles.map((t) => (
            <div key={t.key} className="rounded-2xl border border-white/7 bg-white/3 px-2.5 py-2">
              <div className="kpi-label">{t.label}</div>
              <div className={`mono-num text-[15px] font-semibold ${t.tone === "good" ? "text-emerald-400" : t.tone === "bad" ? "text-ruby-400" : "text-white"}`}>
                {t.value}
              </div>
            </div>
          ))}
        </div>
      </header>

      {/* Desktop: chart left, controls right. Mobile: one column. */}
      <main className={`flex-1 px-4 pt-4 ${nav === "trade" ? "lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-5" : ""}`}>
        {nav === "trade" && (
          <>
        <div className="lg:min-w-0">
          <section className="mb-3">
            <button
              onClick={() => { tap(); setAssetSheetOpen(true); }}
              className="flex w-full items-center justify-between rounded-2xl border border-white/8 bg-white/3 px-3.5 py-3 text-left active:scale-[0.99]"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-white">{symbol}</span>
                  <span className="text-[12px] text-white/40">{symbolName}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-white/35">
                  {engine?.updatedAt ? `Updated ${timeAgo(engine.updatedAt)}` : "Awaiting data"}
                </div>
              </div>
              <div className="text-right">
                <div className="mono-num font-display text-[24px] leading-none tracking-tight text-white">
                  {price === null ? "—" : money(price)}
                </div>
                {change !== null && (
                  <div className={`mono-num mt-1 text-[12px] font-semibold ${change >= 0 ? "text-emerald-400" : "text-ruby-400"}`}>
                    {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(3)}%
                  </div>
                )}
              </div>
            </button>
          </section>

          <div className="mb-3 flex rounded-2xl border border-white/8 bg-white/3 p-1">
            {(["trade", "positions", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => { tap(); setTab(t); }}
                className={`flex-1 rounded-xl px-3 py-2 text-[12.5px] font-semibold capitalize transition ${tab === t ? "bg-white/10 text-white" : "text-white/45"}`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "trade" && (
            <>
              <Card className="mb-3 !p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex gap-1 overflow-x-auto">
                    {timeframes.map((tf) => (
                      <button
                        key={tf}
                        onClick={() => { tap(); setTimeframe(tf); }}
                        className={`chip shrink-0 ${timeframe === tf ? "chip-active" : ""}`}
                      >
                        {TIMEFRAME_LABELS[tf] ?? `${tf}s`}
                      </button>
                    ))}
                  </div>
                  {chartLoading && <Spinner size={13} />}
                </div>
                <div className="mb-2 flex gap-1">
                  {INDICATORS.map((ind) => (
                    <button
                      key={ind.key}
                      onClick={() => { tap(); setIndicators((prev) => (prev.includes(ind.key) ? prev.filter((k) => k !== ind.key) : [...prev, ind.key])); }}
                      className={`chip ${indicators.includes(ind.key) ? "chip-active" : ""}`}
                    >
                      {ind.label}
                    </button>
                  ))}
                </div>
                <Chart
                  candles={candles}
                  indicators={indicators}
                  height={chartHeight}
                  revision={candles.length}
                  chartStyle={chartStyle}
                  grid={chartGrid}
                />
              </Card>

              <div className="mb-4 grid grid-cols-2 gap-3">
                <button
                  className="btn-primary py-4 text-[16px]"
                  onClick={() => { tap(); setOrderSheet("buy"); }}
                  disabled={!engine}
                >
                  Buy
                </button>
                <button
                  className="btn-danger py-4 text-[16px]"
                  onClick={() => { tap(); setOrderSheet("sell"); }}
                  disabled={!engine}
                >
                  Sell
                </button>
              </div>
            </>
          )}

          {tab === "positions" && (
            <Card className="mb-3">
              <SectionTitle>All positions</SectionTitle>
              {positions.length === 0 ? (
                <EmptyState title="No positions" body="The broker reports no open positions for the active account." />
              ) : (
                positions.map((p) => (
                  <Row key={p.id} label={`${p.side.toUpperCase()} ${p.symbol}`} hint={`Updated ${timeAgo(p.updated_at)}`} value={signed(Number(p.unrealized_pnl ?? 0))} />
                ))
              )}
            </Card>
          )}

          {tab === "history" && (
            <>
              <Card className="mb-3">
                <SectionTitle>Performance</SectionTitle>
                {perf && perf.totalTrades > 0 ? (
                  <>
                    <Row label="Settled trades" value={String(perf.totalTrades)} />
                    <Row label="Win rate" value={`${(perf.winRate * 100).toFixed(1)}%`} />
                    <Row label="Net P&L" value={signed(perf.netPnl)} tone={perf.netPnl >= 0 ? "good" : "bad"} />
                    <Row label="Profit factor" value={perf.profitFactor === null ? "—" : perf.profitFactor.toFixed(2)} />
                    <Row label="Expectancy" value={signed(perf.expectancy)} tone={perf.expectancy >= 0 ? "good" : "bad"} />
                    {perf.byStrategy.map((s) => (
                      <Row key={s.strategyId} label={`Strategy ${s.strategyId}`} hint={`${s.trades} trades`} value={signed(s.pnl)} tone={s.pnl >= 0 ? "good" : "bad"} />
                    ))}
                  </>
                ) : (
                  <EmptyState title="No settled trades yet" body="Statistics appear once contracts settle. Nothing is estimated." />
                )}
              </Card>
              <Card className="mb-3">
                <SectionTitle>Order history</SectionTitle>
                {orders.length === 0 ? (
                  <EmptyState title="No orders" body="Order history is empty." />
                ) : (
                  orders.map((o) => (
                    <Row
                      key={o.id}
                      label={`${o.side.toUpperCase()} ${o.symbol} · ${money(o.amount)}`}
                      hint={`${o.origin} · ${o.mode} · ${o.status} · ${timeAgo(o.created_at)}`}
                      value={o.profit === null ? "—" : signed(Number(o.profit))}
                      tone={o.profit === null ? undefined : Number(o.profit) >= 0 ? "good" : "bad"}
                    />
                  ))
                )}
              </Card>
            </>
          )}
        </div>

        {/* Right column on desktop; flows inline on mobile. */}
        <div className="lg:sticky lg:top-[132px]">
          <Card className="mb-3">
            <SectionTitle action={<button className="text-[11px] text-white/45" onClick={() => void loadTradingData()}>Refresh</button>}>
              Active positions
            </SectionTitle>
            {positions.length === 0 ? (
              <EmptyState title="No open positions" body="Positions reported by the broker appear here. Fixed-expiry contracts show as open orders until they settle." />
            ) : (
              positions.map((p) => (
                <Row
                  key={p.id}
                  label={`${p.side.toUpperCase()} ${p.symbol}`}
                  hint={`Size ${money(p.size)} · entry ${money(p.entry_price)} · now ${money(p.current_price)}`}
                  value={signed(Number(p.unrealized_pnl ?? 0))}
                  tone={Number(p.unrealized_pnl ?? 0) >= 0 ? "good" : "bad"}
                />
              ))
            )}
          </Card>

          <Card className="mb-3">
            <SectionTitle>Recent orders</SectionTitle>
            {orders.length === 0 ? (
              <EmptyState title="No orders yet" body="Every order the engine or you place is recorded here with its real broker status." />
            ) : (
              orders.slice(0, 6).map((o) => (
                <Row
                  key={o.id}
                  label={`${o.side.toUpperCase()} ${o.symbol} · ${money(o.amount)}`}
                  hint={`${o.status}${o.error ? ` — ${o.error}` : ""} · ${timeAgo(o.created_at)}`}
                  value={o.profit === null ? o.status : signed(Number(o.profit))}
                  tone={o.profit === null ? undefined : Number(o.profit) >= 0 ? "good" : "bad"}
                />
              ))
            )}
          </Card>

          <Card className="mb-3">
            <SectionTitle>Engine control</SectionTitle>
            {engine?.reason && (
              <div className="mb-3 rounded-2xl border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-[12px] text-amber-200/90">{engine.reason}</div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-primary" disabled={busy !== null || engine?.state === "running" || engine?.state === "emergency"} onClick={() => { tap(); void engineAction("start", "Engine started."); }}>
                {busy === "engine-start" ? <Spinner /> : "Start"}
              </button>
              <button className="btn-ghost" disabled={busy !== null || engine?.state !== "running"} onClick={() => { tap(); void engineAction("pause", "Engine paused.", { reason: "Paused from the app." }); }}>
                {busy === "engine-pause" ? <Spinner /> : "Pause"}
              </button>
              <button className="btn-ghost" disabled={busy !== null || engine?.state === "running" || engine?.state === "emergency"} onClick={() => { tap(); void engineAction("resume", "Engine resumed."); }}>
                {busy === "engine-resume" ? <Spinner /> : "Resume"}
              </button>
              <button className="btn-ghost" disabled={busy !== null || engine?.state === "stopped"} onClick={() => { tap(); setConfirmStop(true); }}>
                Stop
              </button>
            </div>
            <button
              className="btn-danger mt-2 w-full py-3.5"
              disabled={busy !== null || engine?.state === "emergency"}
              onClick={() => { tap(); void engineAction("emergency-stop", "Emergency stop engaged.", { reason: "Emergency stop from the app." }); }}
            >
              {busy === "engine-emergency-stop" ? <Spinner /> : "Emergency stop"}
            </button>
            {engine?.state === "emergency" && (
              <button className="btn-gold mt-2 w-full" disabled={busy !== null} onClick={() => { tap(); void engineAction("reset-emergency", "Emergency stop cleared."); }}>
                {busy === "engine-reset-emergency" ? <Spinner /> : "Reset emergency stop"}
              </button>
            )}
          </Card>
        </div>
          </>
        )}

        {nav === "positions" && <PositionsScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}
        {nav === "discover" && <DiscoverScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}
        {nav === "assets" && <AssetsScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}

        {nav === "more" && more === null && (
          <Card>
            <SectionTitle>More</SectionTitle>
            {(Object.keys(MORE_LABELS) as Array<Exclude<MoreKey, "hub">>)
              .filter((k) => k !== "admin" || isOwner)
              .filter((k) => k !== "members" || isModerator)
              .map((k) => (
                <button
                  key={k}
                  onClick={() => { tap(); setMore(k); }}
                  className="flex w-full items-center justify-between border-b border-white/6 py-3.5 text-left last:border-0 active:opacity-70"
                >
                  <span className="text-[13.5px] text-white/85">{MORE_LABELS[k]}</span>
                  <span className="text-white/30">›</span>
                </button>
              ))}
            <button
              onClick={() => { tap(); void api.post("/api/auth/logout").then(() => window.location.reload()); }}
              className="mt-3 w-full rounded-2xl border border-ruby-500/30 bg-ruby-500/8 py-3 text-[13px] font-semibold text-ruby-400 active:scale-[0.99]"
            >
              Sign out
            </button>
          </Card>
        )}

        {nav === "more" && more !== null && (
          <>
            <button className="mb-3 text-[13px] text-white/50 active:opacity-70" onClick={() => { tap(); setMore(null); }}>‹ Back</button>
            {more === "history" && <HistoryScreen notify={notify} onOpenControls={() => setPanelsOpen(true)} engine={engine} />}
            {more === "notifications" && <NotificationsScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}
            {more === "community" && <CommunityScreen notify={notify} />}
            {more === "messages" && <MessagingScreen notify={notify} />}
            {more === "members" && <MembersScreen notify={notify} />}
            {more === "profile" && <ProfileScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}
            {more === "support" && <SupportScreen engine={engine} notify={notify} onOpenControls={() => setPanelsOpen(true)} />}
            {more === "admin" && isOwner && <AdminScreen notify={notify} />}
          </>
        )}
      </main>

      {/* iPhone-style bottom tab bar. Every item performs a real navigation. */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-white/8 bg-ink-950/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1180px] items-stretch">
          {([
            { key: "trade" as NavKey, label: "Trade" },
            { key: "positions" as NavKey, label: "Positions" },
            { key: "discover" as NavKey, label: "Discover" },
            { key: "assets" as NavKey, label: "Assets" },
            { key: "more" as NavKey, label: "More" },
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => { tap(); setNav(item.key); setMore(null); }}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium transition ${
                nav === item.key ? "text-champagne-300" : "text-white/40"
              }`}
            >
              <span className={`h-1 w-1 rounded-full ${nav === item.key ? "bg-champagne-300" : "bg-transparent"}`} />
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="fixed bottom-5 right-4 z-50 flex flex-col items-end gap-2">
        {v.transcript && (
          <div className="max-w-[220px] rounded-2xl border border-white/12 bg-ink-800/95 px-3 py-2 text-[11.5px] leading-snug text-white/80 backdrop-blur">
            {v.transcript}
          </div>
        )}
        <div className="relative">
          <Avatar state={avatarState} size={64} urgency={urgency} onClick={() => setConsoleOpen(true)} speech={v.speechRef} />
          {notifications.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-ruby-500 px-1 text-[10px] font-bold text-white">
              {notifications.length > 9 ? "9+" : notifications.length}
            </span>
          )}
        </div>
      </div>

      <OrderSheet
        side={orderSheet}
        symbol={symbol}
        amount={amount}
        duration={duration}
        onAmount={setAmount}
        onDuration={setDuration}
        onClose={() => setOrderSheet(null)}
        onSubmit={() => orderSheet && void placeOrder(orderSheet)}
        busy={busy === "order-buy" || busy === "order-sell"}
        risk={risk}
      />

      <AssetSheet
        open={assetSheetOpen}
        onClose={() => setAssetSheetOpen(false)}
        query={assetQuery}
        onQuery={setAssetQuery}
        instruments={app.instruments}
        onLoad={() => void app.loadInstruments()}
        onSelect={(sym) => {
          setAssetSheetOpen(false);
          void run("symbol", async () => {
            await api.post("/api/engine/symbol", { symbol: sym });
            notify(`Active instrument set to ${sym}.`, "good");
          });
        }}
        current={symbol}
      />

      <ConfirmDialog
        open={confirmStop}
        title="Stop the engine?"
        body="The engine stops evaluating strategies and placing orders. Open positions remain at the broker and are not closed by this action."
        confirmLabel="Stop engine"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void engineAction("stop", "Engine stopped.", { reason: "Stopped from the app." });
        }}
      />

      <PhirstConsole
        open={consoleOpen}
        onClose={() => setConsoleOpen(false)}
        chatLog={chatLog}
        busy={chatBusy}
        onAsk={(m) => void askPhirst(m)}
        avatarState={avatarState}
        urgency={urgency}
        voice={v}
        voiceSettings={voiceSettings}
        engine={engine}
        onTap={tap}
      />

      <Sheet open={panelsOpen} title="Controls" onClose={() => setPanelsOpen(false)}>
        <Panels
          app={app}
          perf={perf}
          onClose={() => setPanelsOpen(false)}
          onRefresh={async () => {
            await refresh();
            await loadTradingData();
          }}
        />
      </Sheet>
    </div>
  );
}
