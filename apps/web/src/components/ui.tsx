"use client";

import { useEffect, useState } from "react";
import { Emblem } from "./Emblem";

export function Card({ children, className = "", raised = false }: { children: React.ReactNode; className?: string; raised?: boolean }) {
  return <div className={`${raised ? "glass-raised" : "glass"} p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase text-white/55" style={{ letterSpacing: "0.14em" }}>
        <span className="h-3 w-[2px] rounded-full" style={{ background: "linear-gradient(180deg, #E8CE7A, rgba(212,175,55,0.25))" }} />
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn" | "gold"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    neutral: "tile text-white/70",
    good: "border-emerald-500/40 bg-emerald-500/12 text-emerald-400",
    bad: "border-ruby-500/40 bg-ruby-500/12 text-ruby-400",
    warn: "border-amber-400/40 bg-amber-400/12 text-amber-300",
    gold: "border-champagne-500/40 bg-champagne-500/12 text-champagne-300",
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export function Dot({ tone = "neutral", pulse = false }: { tone?: "neutral" | "good" | "bad" | "warn"; pulse?: boolean }) {
  const colors: Record<string, string> = {
    neutral: "bg-white/40",
    good: "bg-emerald-400",
    bad: "bg-ruby-400",
    warn: "bg-amber-400",
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[tone]} ${pulse ? "animate-pulse-soft" : ""}`} />;
}

export function Toast({ message, tone = "neutral", onDone }: { message: string; tone?: "neutral" | "good" | "bad" | "warn"; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [message, onDone]);
  const tones: Record<string, string> = {
    neutral: "border-white/12 bg-ink-800/95",
    good: "border-emerald-500/40 bg-emerald-950/90",
    bad: "border-ruby-500/45 bg-ruby-950/90",
    warn: "border-amber-400/40 bg-amber-950/90",
  };
  return (
    <div className={`fixed inset-x-0 top-3 z-[70] mx-auto w-[calc(100%-24px)] max-w-[460px] animate-fade-up rounded-2xl border px-4 py-3 text-[13px] leading-snug shadow-glass backdrop-blur-xl ${tones[tone]}`}>
      {message}
    </div>
  );
}

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <div className="sheet safe-bottom flex max-h-[92dvh] flex-col">
        <div className="pt-2.5">
          <div className="sheet-grab" />
        </div>
        <div className="flex items-center justify-between border-b border-white/8 px-5 pb-4 pt-1">
          <h3 className="text-[16px] font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="rounded-full border border-white/12 px-3 py-1 text-[12px] text-white/70 active:scale-95" aria-label="Close">
            Done
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[30px] w-[52px] shrink-0 rounded-full border transition-colors duration-200 ${
        checked ? "border-emerald-400/60 bg-emerald-500/35" : "border-white/12 bg-white/8"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[24px] w-[24px] rounded-full bg-white shadow transition-all duration-200 ${
          checked ? "left-[26px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

export function Row({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-ruby-400" : "text-white";
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/6 py-2.5 last:border-0">
      <div>
        <div className="text-[13px] text-white/75">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-white/35">{hint}</div>}
      </div>
      <div className={`mono-num shrink-0 text-[13px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-white/20 border-t-white/80"
      style={{ width: size, height: size }}
    />
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/12 px-4 py-6 text-center"
      style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.022) 0%, rgba(255,255,255,0) 100%)" }}
    >
      <Emblem size={26} className="mx-auto mb-2.5 opacity-45" />
      <div className="text-[13px] font-medium text-white/70">{title}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-white/40">{body}</div>
    </div>
  );
}

/** Confirm dialog for irreversible or real-money actions. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = "danger",
  requirePhrase,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  requirePhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  useEffect(() => { if (open) setPhrase(""); }, [open]);
  if (!open) return null;
  const ready = !requirePhrase || phrase.trim() === requirePhrase;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onCancel} />
      <div className="glass-raised relative w-full max-w-[400px] p-5">
        <h3 className="text-[16px] font-semibold text-white">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-white/60">{body}</p>
        {requirePhrase && (
          <div className="mt-4">
            <label className="label">Type {requirePhrase} to confirm</label>
            <input className="field mono-num" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={requirePhrase} autoFocus />
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onCancel}>Cancel</button>
          <button className={tone === "danger" ? "btn-danger flex-1" : "btn-primary flex-1"} disabled={!ready} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
