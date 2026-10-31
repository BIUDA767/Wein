"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiFailure,
  type EngineStatus,
  type MemberRecord,
  type ModerationNotice,
  type NotificationRecord,
  type OrderRecord,
  type PerformanceReport,
  type PositionRecord,
} from "@/lib/api";
import { money, signed, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Card, EmptyState, Pill, Row, SectionTitle, Spinner } from "./ui";

/** Shared props: every screen reads the same live engine snapshot. */
export interface ScreenProps {
  engine: EngineStatus | null;
  notify: (text: string, tone?: "neutral" | "good" | "bad" | "warn") => void;
  onOpenControls: () => void;
}

function usePoll<T>(path: string, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs, enabled]);

  return { data, error, loading, reload: load };
}

// --- Assets -------------------------------------------------------------------

/**
 * Detailed financial view. Every figure comes from the engine snapshot, which reads the
 * active broker account; nothing is computed locally from a fabricated number.
 */
export function AssetsScreen({ engine, notify }: ScreenProps) {
  const { data: perf } = usePoll<PerformanceReport>("/api/reports/performance", 8000);
  const { data: orders } = usePoll<{ orders: OrderRecord[] }>("/api/orders?limit=200", 8000);
  const { data: positions } = usePoll<{ positions: PositionRecord[] }>("/api/positions", 8000);
  const { data: equity } = usePoll<{ series: Array<{ equity: string | number; at: string }> }>("/api/equity", 15000);

  const open = positions?.positions ?? [];
  const allOrders = orders?.orders ?? [];
  const exposure = open.reduce((a, p) => a + Math.abs(Number(p.size ?? 0)), 0);
  const settled = allOrders.filter((o) => o.status === "settled");
  const deposits = 0; // Deposits and withdrawals are only ever shown when the broker supplies them.
  const withdrawals = 0;

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Account</SectionTitle>
        {!engine ? (
          <EmptyState title="Not connected" body="Connect a broker to see your balance and equity." />
        ) : (
          <>
            <Row label="Available balance" value={money(engine.balance)} />
            <Row label="Account equity" value={money(engine.equity)} hint="Balance plus unrealised P&L" />
            <Row label="Unrealised P&L" value={signed(engine.unrealized)} tone={engine.unrealized >= 0 ? "good" : "bad"} />
            <Row label="Daily profit / loss" value={signed(engine.dailyPnl)} tone={engine.dailyPnl >= 0 ? "good" : "bad"} />
            <Row
              label="Total profit / loss"
              value={perf && perf.totalTrades > 0 ? signed(perf.netPnl) : "—"}
              tone={perf && perf.netPnl >= 0 ? "good" : "bad"}
              hint={perf && perf.totalTrades > 0 ? `${perf.totalTrades} settled trades` : "No settled trades yet"}
            />
            <Row label="Portfolio exposure" value={money(exposure)} hint={`${open.length} open position${open.length === 1 ? "" : "s"}`} />
            <Row label="Drawdown" value={`${(engine.drawdown * 100).toFixed(2)}%`} tone={engine.drawdown > 0.1 ? "bad" : undefined} />
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Open positions</SectionTitle>
        {open.length === 0 ? (
          <EmptyState title="No open positions" body="Positions reported by the broker appear here." />
        ) : (
          open.map((p) => (
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

      <Card>
        <SectionTitle>Deposits and withdrawals</SectionTitle>
        <Row label="Deposits" value={money(deposits)} />
        <Row label="Withdrawals" value={money(withdrawals)} />
        <p className="mt-3 text-[11.5px] leading-relaxed text-white/35">
          Deposits and withdrawals are shown only when the connected broker reports them. The paper
          simulator has no deposit or withdrawal history, so this reads zero rather than a sample figure.
        </p>
      </Card>

      <Card>
        <SectionTitle>Equity history</SectionTitle>
        {!equity || equity.series.length === 0 ? (
          <EmptyState title="No equity history yet" body="Snapshots are recorded as the engine runs." />
        ) : (
          <>
            <Row label="Snapshots recorded" value={String(equity.series.length)} />
            <Row
              label="Most recent"
              value={money(Number(equity.series[0]!.equity))}
              hint={timeAgo(equity.series[0]!.at)}
            />
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Transaction history</SectionTitle>
        {settled.length === 0 ? (
          <EmptyState title="No transactions" body="Settled trades appear here with their real broker result." />
        ) : (
          settled.slice(0, 40).map((o) => (
            <Row
              key={o.id}
              label={`${o.side.toUpperCase()} ${o.symbol} · ${money(o.amount)}`}
              hint={`${o.origin} · ${o.mode} · ${timeAgo(o.created_at)}`}
              value={o.profit === null ? "—" : signed(Number(o.profit))}
              tone={o.profit === null ? undefined : Number(o.profit) >= 0 ? "good" : "bad"}
            />
          ))
        )}
      </Card>
    </div>
  );
}

// --- Positions ----------------------------------------------------------------

export function PositionsScreen({ engine, notify }: ScreenProps) {
  const { data: positions, reload, loading } = usePoll<{ positions: PositionRecord[] }>("/api/positions", 5000);
  const { data: orders, reload: reloadOrders } = usePoll<{ orders: OrderRecord[] }>("/api/orders?limit=100", 5000);
  const open = (orders?.orders ?? []).filter((o) => ["open", "submitted", "pending", "partially_filled"].includes(o.status));
  const list = positions?.positions ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle action={<button className="text-[11px] text-white/45" onClick={() => { void reload(); void reloadOrders(); }}>Refresh</button>}>
          Open positions
        </SectionTitle>
        {list.length === 0 ? (
          <EmptyState title="No open positions" body="Positions reported by the broker appear here. Fixed-expiry contracts show as open orders until they settle." />
        ) : (
          list.map((p) => (
            <Row
              key={p.id}
              label={`${p.side.toUpperCase()} ${p.symbol}`}
              hint={`Size ${money(p.size)} · entry ${money(p.entry_price)} · now ${money(p.current_price)} · ${timeAgo(p.updated_at)}`}
              value={signed(Number(p.unrealized_pnl ?? 0))}
              tone={Number(p.unrealized_pnl ?? 0) >= 0 ? "good" : "bad"}
            />
          ))
        )}
      </Card>

      <Card>
        <SectionTitle>Working orders</SectionTitle>
        {open.length === 0 ? (
          <EmptyState title="No working orders" body="Orders awaiting a broker result appear here." />
        ) : (
          open.map((o) => (
            <Row
              key={o.id}
              label={`${o.side.toUpperCase()} ${o.symbol} · ${money(o.amount)}`}
              hint={`${o.status} · ${o.mode} · ${o.duration_sec ? `${o.duration_sec}s` : "market"} · ${timeAgo(o.created_at)}`}
              value={<Pill tone={o.status === "open" ? "good" : "warn"}>{o.status}</Pill>}
            />
          ))
        )}
      </Card>

      <Card>
        <SectionTitle>Engine</SectionTitle>
        {!engine ? (
          <EmptyState title="Engine unavailable" body="The engine snapshot could not be read." />
        ) : (
          <>
            <Row label="State" value={<Pill tone={engine.state === "running" ? "good" : engine.state === "emergency" ? "bad" : "neutral"}>{engine.state}</Pill>} />
            <Row label="Mode" value={engine.mode === "live" ? <Pill tone="bad">LIVE</Pill> : <Pill tone="gold">PAPER</Pill>} />
            <Row label="Broker" value={engine.brokerName ?? "none"} />
            <Row label="Instrument" value={engine.symbol} />
            <Row label="Open trades" value={String(engine.openTrades)} />
            <Row label="Consecutive losses" value={String(engine.consecutiveLosses)} tone={engine.consecutiveLosses > 0 ? "bad" : undefined} />
          </>
        )}
        {loading && <div className="mt-3 flex justify-center"><Spinner size={14} /></div>}
      </Card>
    </div>
  );
}

// --- History ------------------------------------------------------------------

export function HistoryScreen({ notify }: ScreenProps) {
  const { data: perf } = usePoll<PerformanceReport>("/api/reports/performance", 10000);
  const { data: orders, reload } = usePoll<{ orders: OrderRecord[] }>("/api/orders?limit=200", 10000);
  const [detail, setDetail] = useState<OrderRecord | null>(null);
  const list = orders?.orders ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle action={<button className="text-[11px] text-white/45" onClick={() => void reload()}>Refresh</button>}>
          Performance
        </SectionTitle>
        {perf && perf.totalTrades > 0 ? (
          <>
            <Row label="Settled trades" value={String(perf.totalTrades)} />
            <Row label="Wins / losses" value={`${perf.wins} / ${perf.losses}`} />
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

      <Card>
        <SectionTitle>Deals</SectionTitle>
        {list.length === 0 ? (
          <EmptyState title="No deals" body="Every order you or the engine place is recorded here with its real broker status." />
        ) : (
          list.map((o) => (
            <button
              key={o.id}
              onClick={() => setDetail(o)}
              className="flex w-full items-start justify-between gap-4 border-b border-white/6 py-2.5 text-left last:border-0 active:opacity-70"
            >
              <div>
                <div className="text-[13px] text-white/80">{o.side.toUpperCase()} {o.symbol} · {money(o.amount)}</div>
                <div className="mt-0.5 text-[11px] text-white/35">
                  {o.origin} · {o.mode} · {o.status} · {timeAgo(o.created_at)}
                </div>
              </div>
              <div className={`mono-num shrink-0 text-[13px] font-semibold ${o.profit === null ? "text-white/60" : Number(o.profit) >= 0 ? "text-emerald-400" : "text-ruby-400"}`}>
                {o.profit === null ? o.status : signed(Number(o.profit))}
              </div>
            </button>
          ))
        )}
      </Card>

      {/* Trade detail bottom sheet. */}
      {detail && (
        <div className="fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDetail(null)} />
          <div className="sheet safe-bottom max-h-[80dvh] overflow-y-auto px-5 py-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-white">Trade detail</h3>
              <button onClick={() => setDetail(null)} className="rounded-full border border-white/12 px-3 py-1 text-[12px] text-white/70">Done</button>
            </div>
            <Row label="Side" value={detail.side.toUpperCase()} />
            <Row label="Instrument" value={detail.symbol} />
            <Row label="Type" value={detail.order_type} />
            <Row label="Amount" value={money(detail.amount)} />
            <Row label="Duration" value={detail.duration_sec ? `${detail.duration_sec}s` : "—"} />
            <Row label="Status" value={detail.status} />
            <Row label="Fill price" value={detail.fill_price === null ? "—" : money(detail.fill_price)} />
            <Row label="Payout" value={detail.payout === null ? "—" : money(detail.payout)} />
            <Row label="Profit / loss" value={detail.profit === null ? "—" : signed(Number(detail.profit))} tone={detail.profit === null ? undefined : Number(detail.profit) >= 0 ? "good" : "bad"} />
            <Row label="Origin" value={detail.origin} />
            <Row label="Mode" value={detail.mode} />
            <Row label="Strategy" value={detail.strategy_id ?? "manual"} />
            <Row label="Broker order id" value={detail.broker_order_id ?? "—"} />
            <Row label="Placed" value={new Date(detail.created_at).toLocaleString()} />
            <Row label="Settled" value={detail.settled_at ? new Date(detail.settled_at).toLocaleString() : "—"} />
            {detail.error && (
              <div className="mt-3 rounded-2xl border border-ruby-500/30 bg-ruby-500/10 px-3.5 py-2.5 text-[12px] text-ruby-400">
                {detail.error}
              </div>
            )}
            <p className="mt-4 text-[11px] leading-relaxed text-white/35">
              These are the broker's reported values for this order. WEIN does not adjust or estimate them.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Discover -----------------------------------------------------------------

/**
 * Discover lists the instruments the active broker actually reports, grouped by asset
 * class. Nothing here is a curated "featured" list of instruments the broker cannot trade.
 */
export function DiscoverScreen({ engine, notify }: ScreenProps) {
  const { data, loading, error } = usePoll<{ instruments: Array<{ symbol: string; name: string; assetClass: string; tradeable: boolean }>; total: number }>(
    "/api/market/instruments",
    30000,
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const list = (data?.instruments ?? []).filter(
    (i) => !query || i.symbol.toLowerCase().includes(query.toLowerCase()) || i.name.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = list.reduce<Record<string, typeof list>>((acc, i) => {
    (acc[i.assetClass] ??= []).push(i);
    return acc;
  }, {});

  const setActive = async (symbol: string) => {
    setBusy(symbol);
    try {
      await api.post("/api/engine/symbol", { symbol });
      notify(`Active instrument set to ${symbol}.`, "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Instruments</SectionTitle>
        <input
          className="field mb-3"
          placeholder="Search symbol or name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : error ? (
          <EmptyState title="Market data unavailable" body={error} />
        ) : list.length === 0 ? (
          <EmptyState title="No instruments" body="The active broker reported no instruments matching this search." />
        ) : (
          Object.entries(groups).map(([assetClass, items]) => (
            <div key={assetClass} className="mb-3 last:mb-0">
              <div className="label mb-2 mt-1">{assetClass}</div>
              {items.slice(0, 60).map((i) => (
                <button
                  key={i.symbol}
                  disabled={busy !== null || !i.tradeable}
                  onClick={() => void setActive(i.symbol)}
                  className="flex w-full items-center justify-between border-b border-white/6 py-2.5 text-left last:border-0 active:opacity-70 disabled:opacity-40"
                >
                  <div>
                    <div className="text-[13px] text-white/85">{i.symbol}</div>
                    <div className="text-[11px] text-white/35">{i.name}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {engine?.symbol === i.symbol && <Pill tone="gold">active</Pill>}
                    {busy === i.symbol && <Spinner size={12} />}
                    {!i.tradeable && <Pill tone="neutral">view only</Pill>}
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
        {data && (
          <p className="mt-3 text-[11px] text-white/35">
            {list.length} of {data.total} instruments reported by the active broker.
          </p>
        )}
      </Card>
    </div>
  );
}

// --- Notifications ------------------------------------------------------------

export function NotificationsScreen({ notify }: ScreenProps) {
  const { data, reload } = usePoll<{ notifications: NotificationRecord[] }>("/api/notifications?limit=100", 8000);
  const list = data?.notifications ?? [];

  const markRead = async (id: string) => {
    try {
      await api.post(`/api/notifications/${id}/read`);
      await reload();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };
  const markAll = async () => {
    try {
      await api.post("/api/notifications/read-all");
      await reload();
      notify("All notifications marked read.", "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const tone = (s: string) => (s === "critical" ? "bad" : s === "warning" ? "warn" : "neutral");

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle action={list.length > 0 ? <button className="text-[11px] text-white/45" onClick={() => void markAll()}>Mark all read</button> : undefined}>
          Notifications
        </SectionTitle>
        {list.length === 0 ? (
          <EmptyState title="No notifications" body="PHIRST2 raises an alert only for meaningful market, risk or system events." />
        ) : (
          list.map((n) => (
            <button
              key={n.id}
              onClick={() => void markRead(n.id)}
              className={`flex w-full flex-col items-start gap-1 border-b border-white/6 py-3 text-left last:border-0 active:opacity-70 ${n.read_at ? "opacity-55" : ""}`}
            >
              <div className="flex w-full items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-white/90">{n.title}</span>
                <Pill tone={tone(n.severity)}>{n.severity}</Pill>
              </div>
              <div className="text-[12px] leading-relaxed text-white/50">{n.body}</div>
              <div className="text-[10.5px] text-white/30">{n.category} · {timeAgo(n.created_at)}</div>
            </button>
          ))
        )}
      </Card>
    </div>
  );
}

// --- Profile ------------------------------------------------------------------

export function ProfileScreen({ engine, notify, onOpenControls }: ScreenProps) {
  const { identity, isOwner } = useSession();
  const [displayName, setDisplayName] = useState(identity.displayName ?? "");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [moderation, setModeration] = useState<ModerationNotice[]>([]);
  const [appealText, setAppealText] = useState("");
  const [appealFor, setAppealFor] = useState<string | null>(null);

  const { data: me } = usePoll<{ members: MemberRecord[] }>("/api/community/members", 30000);
  const self = me?.members.find((m) => m.id === identity.id);
  useEffect(() => {
    if (self) setBio(self.bio ?? "");
  }, [self]);

  const loadModeration = useCallback(async () => {
    try {
      const res = await api.get<{ notices: ModerationNotice[] }>("/api/community/moderation");
      setModeration(res.notices);
    } catch {
      /* non-fatal */
    }
  }, []);
  useEffect(() => { void loadModeration(); }, [loadModeration]);

  const saveProfile = async () => {
    setBusy(true);
    try {
      await api.put("/api/profile", { displayName: displayName.trim() || null, bio: bio.trim() || null });
      notify("Profile saved.", "good");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 12) {
      notify("New password must be at least 12 characters.", "bad");
      return;
    }
    if (newPassword !== confirmPassword) {
      notify("New passwords do not match.", "bad");
      return;
    }
    setPwBusy(true);
    try {
      const res = await api.post<{ sessionsRevoked: number }>("/api/auth/change-password", { currentPassword, newPassword });
      notify(`Password changed. ${res.sessionsRevoked} other session(s) signed out.`, "good");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setPwBusy(false);
    }
  };

  const submitAppeal = async () => {
    if (appealText.trim().length < 10) {
      notify("Explain your case in at least 10 characters.", "bad");
      return;
    }
    try {
      await api.post("/api/community/appeals", { actionId: appealFor, text: appealText.trim() });
      notify("Appeal submitted for review.", "good");
      setAppealText("");
      setAppealFor(null);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Account</SectionTitle>
        <Row label="Username" value={identity.username} />
        <Row label="Role" value={<Pill tone={isOwner ? "gold" : identity.role === "moderator" ? "good" : "neutral"}>{identity.role}</Pill>} />
        <Row label="Account mode" value={engine?.mode === "live" ? <Pill tone="bad">LIVE</Pill> : <Pill tone="gold">PAPER</Pill>} />
        <Row label="Broker" value={engine?.brokerName ?? "none connected"} />
      </Card>

      <Card>
        <SectionTitle>Profile</SectionTitle>
        <div className="mb-3">
          <label className="label" htmlFor="display">Display name</label>
          <input id="display" className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Shown in the community" />
        </div>
        <div className="mb-3">
          <label className="label" htmlFor="bio">Bio</label>
          <textarea id="bio" className="field" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A short line about your trading" />
        </div>
        <button className="btn-primary w-full" onClick={() => void saveProfile()} disabled={busy}>
          {busy ? <Spinner /> : "Save profile"}
        </button>
      </Card>

      <Card>
        <SectionTitle>Change password</SectionTitle>
        <div className="mb-3">
          <label className="label" htmlFor="cur">Current password</label>
          <input id="cur" type="password" className="field" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <div className="mb-3">
          <label className="label" htmlFor="new">New password</label>
          <input id="new" type="password" className="field" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" placeholder="At least 12 characters" />
        </div>
        <div className="mb-3">
          <label className="label" htmlFor="conf">Confirm new password</label>
          <input id="conf" type="password" className="field" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <button className="btn-ghost w-full" onClick={() => void changePassword()} disabled={pwBusy || !currentPassword || !newPassword}>
          {pwBusy ? <Spinner /> : "Change password"}
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-white/35">
          Changing your password signs out every other session but keeps this one.
        </p>
      </Card>

      <Card>
        <SectionTitle>Controls</SectionTitle>
        <button className="btn-ghost w-full" onClick={onOpenControls}>Open broker, risk, strategy and voice controls</button>
      </Card>

      {moderation.length > 0 && (
        <Card>
          <SectionTitle>Moderation notices</SectionTitle>
          {moderation.map((n) => (
            <div key={n.id} className="border-b border-white/6 py-3 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-white/90">{n.title}</span>
                <span className="text-[10.5px] text-white/30">{timeAgo(n.createdAt)}</span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-white/50">{n.body}</p>
              {appealFor === n.id ? (
                <div className="mt-3">
                  <textarea
                    className="field"
                    rows={3}
                    placeholder="Explain why this should be reconsidered"
                    value={appealText}
                    onChange={(e) => setAppealText(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2">
                    <button className="btn-ghost flex-1" onClick={() => { setAppealFor(null); setAppealText(""); }}>Cancel</button>
                    <button className="btn-primary flex-1" onClick={() => void submitAppeal()}>Submit appeal</button>
                  </div>
                </div>
              ) : (
                <button className="mt-2 text-[12px] text-white/50 underline decoration-white/20 underline-offset-4" onClick={() => setAppealFor(n.id)}>
                  Appeal this decision
                </button>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// --- Support ------------------------------------------------------------------

export function SupportScreen({ onOpenControls }: ScreenProps) {
  const [status, setStatus] = useState<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> } | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      setStatus(await api.get<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }>("/api/health"));
    } catch (err) {
      setStatus(null);
      void err;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void check(); }, []);

  const faqs: Array<[string, string]> = [
    ["Is the price on the chart real?", "Yes. Candles and quotes come from the active broker's live market feed. When no feed is connected the chart draws its axes and a connection notice, and no candles at all."],
    ["Why does my balance show as unavailable?", "Balances are read from the broker account. Until a broker is connected and verified there is no real balance to show, so WEIN shows a disconnected state rather than a sample number."],
    ["What is paper mode?", "Paper mode routes orders to an internal simulator that uses live market data for fills and settlement. No order reaches a provider. It is never the default and is always labelled."],
    ["How do I trade real money?", "The owner must first enable live trading platform-wide in the owner dashboard. Then connect a real-money broker account, switch the engine to live and type the confirmation phrase. WEIN never switches to live on its own."],
    ["Does the engine keep running if I close the app?", "Yes. The trading engine is a separate backend process. Closing the browser does not stop it. It is governed only by its running state and the emergency stop."],
    ["Why was my trade skipped?", "The risk engine has final veto. It blocks a trade that would exceed your risk per trade, daily loss limit, drawdown, exposure or concurrent-trade limits, or that the execution agent judged unsafe."],
    ["Where are my broker credentials stored?", "Encrypted with AES-256-GCM and never returned to the browser. They are never written to AI memory and never appear in logs."],
    ["How do I get an account?", "Registration is invite-only. The owner issues an invite code, which works once."],
  ];

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle action={<button className="text-[11px] text-white/45" onClick={() => void check()}>{busy ? "Checking…" : "Re-check"}</button>}>
          System status
        </SectionTitle>
        {!status ? (
          <EmptyState title="Status unavailable" body="The health endpoint could not be reached." />
        ) : (
          Object.entries(status.checks).map(([key, v]) => (
            <Row key={key} label={key} value={<Pill tone={v.ok ? "good" : "warn"}>{v.ok ? "ok" : "attention"}</Pill>} hint={v.detail} />
          ))
        )}
      </Card>

      <Card>
        <SectionTitle>Frequently asked</SectionTitle>
        {faqs.map(([q, a]) => (
          <details key={q} className="border-b border-white/6 py-3 last:border-0">
            <summary className="cursor-pointer text-[13px] font-medium text-white/90">{q}</summary>
            <p className="mt-2 text-[12px] leading-relaxed text-white/50">{a}</p>
          </details>
        ))}
      </Card>

      <Card>
        <SectionTitle>Controls and diagnostics</SectionTitle>
        <button className="btn-ghost w-full" onClick={onOpenControls}>Open controls</button>
      </Card>
    </div>
  );
}
