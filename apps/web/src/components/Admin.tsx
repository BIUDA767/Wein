"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiFailure,
  type AdminOverview,
  type CatalogProvider,
  type InviteRecord,
  type MemberRecord,
  type ModerationActionRecord,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { Card, ConfirmDialog, EmptyState, Pill, Row, SectionTitle, Spinner, Switch } from "./ui";

/**
 * Owner administration. Every action here hits an `ownerOnly` route, so the server
 * refuses a non-owner even if this screen were somehow rendered. The client check is a
 * convenience, not the control.
 */
export function AdminScreen({ notify }: { notify: (t: string, tone?: "neutral" | "good" | "bad" | "warn") => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [moderation, setModeration] = useState<ModerationActionRecord[]>([]);
  const [tab, setTab] = useState<"overview" | "members" | "invites" | "brokers" | "moderation">("overview");
  const [note, setNote] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ov, inv, mem, cat, mod] = await Promise.all([
        api.get<AdminOverview>("/api/admin/overview"),
        api.get<{ invites: InviteRecord[] }>("/api/admin/invites"),
        api.get<{ members: MemberRecord[] }>("/api/admin/members"),
        api.get<{ providers: CatalogProvider[] }>("/api/admin/broker-catalog"),
        api.get<{ actions: ModerationActionRecord[] }>("/api/admin/moderation"),
      ]);
      setOverview(ov);
      setInvites(inv.invites);
      setMembers(mem.members);
      setCatalog(cat.providers);
      setModeration(mod.actions);
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const setLive = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.put("/api/admin/live-trading", { enabled, confirmation: enabled ? "ENABLE GLOBAL LIVE TRADING" : undefined });
      notify(enabled ? "Global live trading enabled." : "Global live trading disabled.", "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
      setConfirmLive(false);
    }
  };

  const createInvite = async () => {
    setBusy(true);
    try {
      const days = Number(expiresInDays);
      const res = await api.post<{ invite: InviteRecord }>("/api/admin/invites", { note: note.trim() || undefined, expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined });
      await navigator.clipboard.writeText(res.invite.code).catch(() => {});
      notify(`Invite created and copied: ${res.invite.code}`, "good");
      setNote("");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    try {
      await api.del(`/api/admin/invites/${code}`);
      notify("Invite revoked.", "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const setRole = async (id: string, role: "member" | "moderator") => {
    try {
      await api.put(`/api/admin/members/${id}/role`, { role });
      notify(`Role set to ${role}.`, "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const setSuspended = async (id: string, suspended: boolean) => {
    let reason: string | null = null;
    if (suspended) {
      reason = window.prompt("Reason for suspending this member?") ?? null;
      if (!reason || reason.trim().length < 3) return;
    }
    try {
      await api.put(`/api/admin/members/${id}/suspension`, { suspended, reason: reason?.trim() });
      notify(suspended ? "Member suspended." : "Member restored.", "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const toggleCatalog = async (provider: string, enabled: boolean) => {
    try {
      await api.put(`/api/admin/broker-catalog/${provider}`, { enabled });
      notify(`${provider} ${enabled ? "enabled" : "disabled"} for members.`, "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  const revertAction = async (id: string) => {
    try {
      await api.post(`/api/admin/moderation/${id}/revert`);
      notify("Moderation action reverted.", "good");
      await load();
    } catch (err) {
      notify(err instanceof ApiFailure ? err.message : (err as Error).message, "bad");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 overflow-x-auto">
        {(["overview", "members", "invites", "brokers", "moderation"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`chip shrink-0 capitalize ${tab === t ? "chip-active" : ""}`}>{t}</button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <Card>
            <SectionTitle>Live trading</SectionTitle>
            <div className="flex items-center justify-between">
              <div className="pr-4">
                <div className="text-[13px] text-white/85">Global master switch</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-white/40">
                  When off, no account on the platform can place a real-money order, whatever its own settings.
                </div>
              </div>
              <Switch checked={overview?.liveTradingEnabled ?? false} onChange={(v) => (v ? setConfirmLive(true) : void setLive(false))} label="Global live trading" />
            </div>
          </Card>
          <Card>
            <SectionTitle>Platform</SectionTitle>
            {!overview ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : (
              <>
                <Row label="Members" value={String(overview.counts.members)} />
                <Row label="Owners" value={String(overview.counts.owners)} />
                <Row label="Moderators" value={String(overview.counts.moderators)} />
                <Row label="Suspended" value={String(overview.counts.suspended)} />
                <Row label="Invites available" value={String(overview.counts.invitesAvailable)} />
                <Row label="Open reports" value={String(overview.counts.openReports)} />
                <Row label="Open appeals" value={String(overview.counts.openAppeals)} />
              </>
            )}
          </Card>
        </>
      )}

      {tab === "invites" && (
        <>
          <Card>
            <SectionTitle>Create invite</SectionTitle>
            <div className="mb-3">
              <label className="label" htmlFor="note">Note (optional)</label>
              <input id="note" className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who is this for" />
            </div>
            <div className="mb-3">
              <label className="label" htmlFor="exp">Expires in days</label>
              <input id="exp" className="field mono-num" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} placeholder="7 (empty for never)" />
            </div>
            <button className="btn-primary w-full" onClick={() => void createInvite()} disabled={busy}>
              {busy ? <Spinner /> : "Create invite code"}
            </button>
          </Card>
          <Card>
            <SectionTitle>Invites</SectionTitle>
            {invites.length === 0 ? (
              <EmptyState title="No invites" body="Create one to invite a member." />
            ) : (
              invites.map((i) => (
                <div key={i.code} className="border-b border-white/6 py-3 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <code className="mono-num text-[12.5px] text-white/85">{i.code}</code>
                    <Pill tone={i.state === "available" ? "good" : i.state === "used" ? "neutral" : "bad"}>{i.state}</Pill>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10.5px] text-white/35">
                      {i.note ? `${i.note} · ` : ""}created {timeAgo(i.createdAt)}{i.expiresAt ? ` · expires ${new Date(i.expiresAt).toLocaleDateString()}` : ""}
                    </span>
                    {i.state === "available" && (
                      <button className="text-[11px] text-ruby-400/80" onClick={() => void revoke(i.code)}>Revoke</button>
                    )}
                  </div>
                </div>
              ))
            )}
          </Card>
        </>
      )}

      {tab === "members" && (
        <Card>
          <SectionTitle>Members</SectionTitle>
          {members.map((m) => (
            <div key={m.id} className="border-b border-white/6 py-3 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-white/90">{m.displayName ?? m.username}</div>
                  <div className="text-[10.5px] text-white/35">@{m.username}</div>
                </div>
                <div className="flex items-center gap-2">
                  {m.role === "owner" && <Pill tone="gold">owner</Pill>}
                  {m.role === "moderator" && <Pill tone="good">moderator</Pill>}
                  {m.suspended && <Pill tone="bad">suspended</Pill>}
                </div>
              </div>
              {m.role !== "owner" && (
                <div className="mt-2 flex gap-2">
                  {m.role === "member" ? (
                    <button className="btn-ghost flex-1 py-2 text-[12px]" onClick={() => void setRole(m.id, "moderator")}>Make moderator</button>
                  ) : (
                    <button className="btn-ghost flex-1 py-2 text-[12px]" onClick={() => void setRole(m.id, "member")}>Remove moderator</button>
                  )}
                  <button
                    className={`${m.suspended ? "btn-primary" : "btn-danger"} flex-1 py-2 text-[12px]`}
                    onClick={() => void setSuspended(m.id, !m.suspended)}
                  >
                    {m.suspended ? "Restore" : "Suspend"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {tab === "brokers" && (
        <Card>
          <SectionTitle>Broker and exchange integrations</SectionTitle>
          {catalog.map((p) => (
            <div key={p.id} className="border-b border-white/6 py-3 last:border-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-white/90">{p.name}</span>
                    {p.implemented ? <Pill tone="good">adapter ready</Pill> : <Pill tone="warn">not implemented</Pill>}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-white/40">{p.notes}</div>
                  {p.requires.length > 0 && (
                    <div className="mt-1 text-[10.5px] text-white/30">Requires: {p.requires.join(", ")}</div>
                  )}
                  <div className="mt-1 text-[10.5px] text-white/30">
                    {p.assetClasses.join(", ")} · {p.fiveSecondExpiry ? "5-second expiry available" : "no fixed expiry"}
                  </div>
                </div>
                <Switch checked={p.enabled} onChange={(v) => void toggleCatalog(p.id, v)} label={`Enable ${p.name}`} />
              </div>
            </div>
          ))}
        </Card>
      )}

      {tab === "moderation" && (
        <Card>
          <SectionTitle>Moderation log</SectionTitle>
          {moderation.length === 0 ? (
            <EmptyState title="No moderation actions" body="Automated and human moderation actions appear here." />
          ) : (
            moderation.map((a) => (
              <div key={a.id} className="border-b border-white/6 py-3 last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Pill tone={a.action === "ban" || a.action === "suspend" ? "bad" : a.action === "warn" ? "warn" : "neutral"}>{a.action}</Pill>
                    <span className="text-[11.5px] text-white/60">{a.targetType}</span>
                    {a.automated && <Pill tone="gold">PHIRST2</Pill>}
                  </div>
                  <span className="text-[10.5px] text-white/30">{timeAgo(a.createdAt)}</span>
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-white/60">{a.reason}</p>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10.5px] text-white/30">by {a.actor}</span>
                  {a.revertedAt ? (
                    <span className="text-[10.5px] text-white/30">reverted {timeAgo(a.revertedAt)}</span>
                  ) : (
                    <button className="text-[11px] text-white/50 underline decoration-white/20 underline-offset-4" onClick={() => void revertAction(a.id)}>Revert</button>
                  )}
                </div>
              </div>
            ))
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirmLive}
        title="Enable global live trading?"
        body="This allows every authorised account on the platform to place real-money orders, subject to each account's own confirmation and risk limits. Only enable this when broker permissions have been verified."
        confirmLabel="Enable live trading"
        requirePhrase="ENABLE GLOBAL LIVE TRADING"
        onCancel={() => setConfirmLive(false)}
        onConfirm={() => void setLive(true)}
      />
    </div>
  );
}
