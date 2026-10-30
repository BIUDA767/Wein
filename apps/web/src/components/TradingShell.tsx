"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, type AvatarState } from "./Avatar";
import { Chart, type IndicatorKey } from "./Chart";
import { Card, ConfirmDialog, Dot, EmptyState, Pill, Row, SectionTitle, Sheet, Spinner, Toast } from "./ui";
import { api, ApiFailure, type Candle, type ChatReply, type EngineStatus, type OrderRecord, type PerformanceReport, type PositionRecord } from "@/lib/api";
import { useAppState } from "@/lib/store";
import { useVoice } from "@/lib/voice";
import { Panels } from "./Panels";
import { OrderSheet, AssetSheet, PhirstConsole } from "./Sheets";
import { money, signed, timeAgo, statusTone } from "@/lib/format";

const TIMEFRAMES = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14400 },
  { label: "1d", seconds: 86400 },
];

const INDICATORS: Array<{ key: IndicatorKey; label: string }> = [
  { key: "ema", label: "EMA" },
  { key: "sma", label: "SMA" },
  { key: "bollinger", label: "BB" },
  { key: "rsi", label: "RSI" },
];

export function TradingShell() {
  const app = useAppState(true);
  const { engine, risk, brokers, notifications, voice, connected, refresh, notify, toasts, dismissToast } = app;

  const [tab, setTab] = useState<"trade" | "positions" | "history">("trade");
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
    enabled: true, voice: "female" as const, accent: "ja-JP-inspired", rate: 1, pitch: 1,
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

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[560px] flex-col pb-24">
      {toasts.map((t) => (
        <Toast key={t.id} message={t.text} tone={t.tone} onDone={() => dismissToast(t.id)} />
      ))}

      <header className="safe-top sticky top-0 z-40 border-b border-white/6 bg-ink-950/85 px-4 pb-3 backdrop-blur-xl">
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-champagne-500/25 bg-champagne-500/10">
              <span className="font-display text-[15px] font-semibold text-champagne-300">P</span>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-display text-[15px] tracking-tight text-white">PHIRST2</span>
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
            <button onClick={() => setPanelsOpen(true)} className="rounded-full border border-white/12 bg-white/5 p-2 active:scale-95" aria-label="Open controls">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="text-white/80">
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-white/7 bg-white/3 px-2.5 py-2">
            <div className="kpi-label">Equity</div>
            <div className="mono-num text-[15px] font-semibold text-white">{money(engine?.equity)}</div>
          </div>
          <div className="rounded-2xl border border-white/7 bg-white/3 px-2.5 py-2">
            <div className="kpi-label">P&amp;L today</div>
            <div className={`mono-num text-[15px] font-semibold ${(engine?.dailyPnl ?? 0) >= 0 ? "text-emerald-400" : "text-ruby-400"}`}>
              {engine ? signed(engine.dailyPnl) : "—"}
            </div>
          </div>
          <div className="rounded-2xl border border-white/7 bg-white/3 px-2.5 py-2">
            <div className="kpi-label">Open</div>
            <div className="mono-num text-[15px] font-semibold text-white">{engine?.openTrades ?? 0}</div>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pt-4">
        <section className="mb-3">
          <button
            onClick={() => setAssetSheetOpen(true)}
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
              onClick={() => setTab(t)}
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
                  {TIMEFRAMES.map((tf) => (
                    <button key={tf.seconds} onClick={() => setTimeframe(tf.seconds)} className={`chip shrink-0 ${timeframe === tf.seconds ? "chip-active" : ""}`}>
                      {tf.label}
                    </button>
                  ))}
                </div>
                {chartLoading && <Spinner size={13} />}
              </div>
              <div className="mb-2 flex gap-1">
                {INDICATORS.map((ind) => (
                  <button
                    key={ind.key}
                    onClick={() => setIndicators((prev) => (prev.includes(ind.key) ? prev.filter((k) => k !== ind.key) : [...prev, ind.key]))}
                    className={`chip ${indicators.includes(ind.key) ? "chip-active" : ""}`}
                  >
                    {ind.label}
                  </button>
                ))}
              </div>
              <Chart candles={candles} indicators={indicators} height={320} revision={candles.length} />
            </Card>

            <div className="mb-4 grid grid-cols-2 gap-3">
              <button className="btn-primary py-4 text-[16px]" onClick={() => setOrderSheet("buy")} disabled={!engine}>
                Buy
              </button>
              <button className="btn-danger py-4 text-[16px]" onClick={() => setOrderSheet("sell")} disabled={!engine}>
                Sell
              </button>
            </div>

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

        <Card className="mb-3">
          <SectionTitle>Engine control</SectionTitle>
          {engine?.reason && (
            <div className="mb-3 rounded-2xl border border-amber-400/25 bg-amber-400/8 px-3 py-2 text-[12px] text-amber-200/90">{engine.reason}</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-primary" disabled={busy !== null || engine?.state === "running" || engine?.state === "emergency"} onClick={() => void engineAction("start", "Engine started.")}>
              {busy === "engine-start" ? <Spinner /> : "Start"}
            </button>
            <button className="btn-ghost" disabled={busy !== null || engine?.state !== "running"} onClick={() => void engineAction("pause", "Engine paused.", { reason: "Paused from the app." })}>
              {busy === "engine-pause" ? <Spinner /> : "Pause"}
            </button>
            <button className="btn-ghost" disabled={busy !== null || engine?.state === "running" || engine?.state === "emergency"} onClick={() => void engineAction("resume", "Engine resumed.")}>
              {busy === "engine-resume" ? <Spinner /> : "Resume"}
            </button>
            <button className="btn-ghost" disabled={busy !== null || engine?.state === "stopped"} onClick={() => setConfirmStop(true)}>
              Stop
            </button>
          </div>
          <button
            className="btn-danger mt-2 w-full py-3.5"
            disabled={busy !== null || engine?.state === "emergency"}
            onClick={() => void engineAction("emergency-stop", "Emergency stop engaged.", { reason: "Emergency stop from the app." })}
          >
            {busy === "engine-emergency-stop" ? <Spinner /> : "Emergency stop"}
          </button>
          {engine?.state === "emergency" && (
            <button className="btn-champagne mt-2 w-full" disabled={busy !== null} onClick={() => void engineAction("reset-emergency", "Emergency stop cleared.")}>
              {busy === "engine-reset-emergency" ? <Spinner /> : "Reset emergency stop"}
            </button>
          )}
        </Card>
      </main>

      <div className="fixed bottom-5 right-4 z-50 flex flex-col items-end gap-2">
        {v.transcript && (
          <div className="max-w-[220px] rounded-2xl border border-white/12 bg-ink-800/95 px-3 py-2 text-[11.5px] leading-snug text-white/80 backdrop-blur">
            {v.transcript}
          </div>
        )}
        <div className="relative">
          <Avatar state={avatarState} size={64} urgency={urgency} onClick={() => setConsoleOpen(true)} />
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
