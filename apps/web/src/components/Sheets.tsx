"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, type AvatarState } from "./Avatar";
import { Dot, EmptyState, Sheet, Spinner } from "./ui";
import { money } from "@/lib/format";
import type { useVoice } from "@/lib/voice";
import type { EngineStatus } from "@/lib/api";

export function OrderSheet({
  side, symbol, amount, duration, onAmount, onDuration, onClose, onSubmit, busy, risk,
}: {
  side: "buy" | "sell" | null;
  symbol: string;
  amount: string;
  duration: string;
  onAmount: (v: string) => void;
  onDuration: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  risk: { maxTradeAmount: number; riskPerTrade: number } | null;
}) {
  const [caps, setCaps] = useState<{ minExpirySec: number | null; fixedExpiry: boolean } | null>(null);
  useEffect(() => {
    if (!side) return;
    setCaps(null);
    void (async () => {
      try {
        const res = await api.get<{ brokers: Array<{ isActive: boolean; capabilities: { minExpirySec?: number | null; fixedExpiry?: boolean } }> }>("/api/brokers");
        const active = res.brokers.find((b) => b.isActive);
        setCaps({ minExpirySec: active?.capabilities?.minExpirySec ?? null, fixedExpiry: active?.capabilities?.fixedExpiry ?? false });
      } catch {
        setCaps(null);
      }
    })();
  }, [side]);

  return (
    <Sheet open={side !== null} title={side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`} onClose={onClose}>
      <div className="mb-4">
        <label className="label">Trade amount</label>
        <input className="field mono-num" inputMode="decimal" value={amount} onChange={(e) => onAmount(e.target.value)} />
        <div className="mt-2 flex gap-1.5">
          {[10, 25, 50, 100].map((v) => (
            <button key={v} className="chip" onClick={() => onAmount(String(v))}>{v}</button>
          ))}
        </div>
        {risk && (
          <p className="mt-2 text-[11px] leading-relaxed text-white/35">
            Risk per trade {(risk.riskPerTrade * 100).toFixed(2)}% · per-trade ceiling {money(risk.maxTradeAmount)}. The risk engine may reduce this amount.
          </p>
        )}
      </div>

      <div className="mb-4">
        <label className="label">Duration (seconds)</label>
        <input className="field mono-num" inputMode="numeric" value={duration} onChange={(e) => onDuration(e.target.value)} />
        <div className="mt-2 flex gap-1.5">
          {[5, 15, 60, 300].map((v) => (
            <button key={v} className="chip" onClick={() => onDuration(String(v))}>{v}s</button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          {caps?.minExpirySec
            ? `The active broker enforces a minimum expiry of ${caps.minExpirySec}s. Orders below it are refused rather than adjusted silently.`
            : "The active broker does not publish a minimum expiry. Orders are submitted as requested."}
        </p>
      </div>

      <button className={side === "buy" ? "btn-primary w-full py-4" : "btn-danger w-full py-4"} onClick={onSubmit} disabled={busy}>
        {busy ? <Spinner /> : `${side === "buy" ? "Buy" : "Sell"} ${symbol}`}
      </button>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-white/30">
        The order is submitted to the active broker. Nothing is reported as filled until the broker confirms it.
      </p>
    </Sheet>
  );
}

export function AssetSheet({
  open, onClose, query, onQuery, instruments, onSelect, onLoad, current,
}: {
  open: boolean;
  onClose: () => void;
  query: string;
  onQuery: (v: string) => void;
  instruments: Array<{ symbol: string; name: string; assetClass: string; tradeable: boolean }>;
  onSelect: (symbol: string) => void;
  onLoad: () => void;
  current: string;
}) {
  useEffect(() => {
    if (open && instruments.length === 0) onLoad();
  }, [open, instruments.length, onLoad]);

  const filtered = instruments.filter(
    (i) => i.symbol.toLowerCase().includes(query.toLowerCase()) || i.name.toLowerCase().includes(query.toLowerCase()),
  );
  const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, i) => {
    (acc[i.assetClass] ??= []).push(i);
    return acc;
  }, {});

  return (
    <Sheet open={open} title="Choose instrument" onClose={onClose}>
      <input className="field mb-4" placeholder="Search symbol or name" value={query} onChange={(e) => onQuery(e.target.value)} />
      {instruments.length === 0 ? (
        <EmptyState title="No instruments loaded" body="Instruments come from the active broker's live catalogue. Connect a broker to load them." />
      ) : (
        Object.entries(grouped).map(([assetClass, list]) => (
          <div key={assetClass} className="mb-5">
            <div className="mb-2 text-[11px] font-semibold uppercase text-white/40" style={{ letterSpacing: "0.12em" }}>
              {assetClass.replace(/_/g, " ")}
            </div>
            <div className="space-y-1">
              {list.map((i) => (
                <button
                  key={i.symbol}
                  onClick={() => onSelect(i.symbol)}
                  disabled={!i.tradeable}
                  className={`flex w-full items-center justify-between rounded-2xl border px-3.5 py-2.5 text-left transition active:scale-[0.99] ${
                    i.symbol === current ? "border-emerald-500/45 bg-emerald-500/10" : "border-white/8 bg-white/3"
                  } ${!i.tradeable ? "opacity-40" : ""}`}
                >
                  <div>
                    <div className="text-[13.5px] font-medium text-white">{i.symbol}</div>
                    <div className="text-[11px] text-white/40">{i.name}</div>
                  </div>
                  {!i.tradeable && <span className="text-[10.5px] text-white/35">closed</span>}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </Sheet>
  );
}

export function PhirstConsole({
  open, onClose, chatLog, busy, onAsk, avatarState, urgency, voice, voiceSettings, engine,
}: {
  open: boolean;
  onClose: () => void;
  chatLog: Array<{ role: "user" | "phirst"; text: string; source?: string; at: string }>;
  busy: boolean;
  onAsk: (m: string) => void;
  avatarState: AvatarState;
  urgency: "normal" | "attention" | "critical";
  voice: ReturnType<typeof useVoice>;
  voiceSettings: { pushToTalk: boolean; handsFree: boolean; enabled: boolean };
  engine: EngineStatus | null;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatLog.length]);

  if (!open) return null;

  const submit = () => {
    if (!input.trim()) return;
    onAsk(input.trim());
    setInput("");
  };

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-ink-950/97 backdrop-blur-2xl">
      <div className="safe-top flex items-center justify-between border-b border-white/8 px-5 py-3">
        <div>
          <div className="font-display text-[17px] tracking-tight text-white">PHIRST2</div>
          <div className="text-[11px] text-white/40">
            {voice.availability.synthesis ? `Voice: ${voice.availability.selectedVoiceName ?? "default"}` : "Speech synthesis unavailable"}
            {voice.availability.japaneseVoices.length > 0 && ` · ${voice.availability.japaneseVoices.length} Japanese voice(s)`}
          </div>
        </div>
        <button onClick={onClose} className="rounded-full border border-white/12 px-3.5 py-1.5 text-[12px] text-white/75 active:scale-95">
          Close
        </button>
      </div>

      <div className="flex flex-col items-center border-b border-white/6 px-5 py-5">
        <Avatar state={avatarState} size={112} urgency={urgency} />
        <div className="mt-3 text-center">
          <div className="text-[13px] font-semibold text-white">
            {avatarState === "speaking" ? "Speaking" : avatarState === "listening" ? "Listening" : avatarState === "thinking" ? "Thinking" : avatarState === "alert" ? "Attention needed" : "Ready"}
          </div>
          <div className="mt-0.5 text-[11px] text-white/40">
            {engine ? `${engine.state} · ${engine.mode} · equity ${money(engine.equity)}` : "Awaiting engine"}
          </div>
        </div>
        {voice.recognitionError && (
          <div className="mt-3 rounded-2xl border border-ruby-500/30 bg-ruby-500/10 px-3 py-2 text-[11.5px] text-ruby-400">
            Microphone: {voice.recognitionError}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {chatLog.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-center text-[12.5px] leading-relaxed text-white/40">
            Ask about your account, risk, positions or market state. PHIRST2 only reports measured facts and labels its own opinion as opinion.
          </div>
        )}
        {chatLog.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[82%] rounded-3xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
                m.role === "user" ? "bg-emerald-500/18 text-white" : "border border-white/10 bg-white/5 text-white/90"
              }`}
            >
              {m.text}
              {m.role === "phirst" && m.source && (
                <div className="mt-1.5 text-[10px] uppercase text-white/30" style={{ letterSpacing: "0.1em" }}>
                  {m.source === "llm" ? "AI opinion + measured facts" : "measured facts only (model offline)"}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-3xl border border-white/10 bg-white/5 px-4 py-2.5">
              <Spinner size={14} />
            </div>
          </div>
        )}
      </div>

      <div className="safe-bottom border-t border-white/8 px-4 pt-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {["Status", "Balance", "Risk", "Positions"].map((q) => (
            <button key={q} className="chip" onClick={() => onAsk(q)}>{q}</button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <button
            onPointerDown={() => voiceSettings.enabled && voice.startListening((text) => onAsk(text))}
            onPointerUp={() => voice.stopListening()}
            onPointerLeave={() => voice.listening && voice.stopListening()}
            disabled={!voiceSettings.enabled || !voice.availability.recognition}
            className={`btn-ghost !px-3.5 ${voice.listening ? "!border-emerald-400/60 !bg-emerald-500/20" : ""}`}
            aria-label="Hold to talk"
          >
            {voice.listening ? (
              <Dot tone="good" pulse />
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
                <path d="M19 11a7 7 0 0 1-14 0M12 18v3" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <input
            className="field flex-1"
            placeholder="Ask PHIRST2…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="btn-primary !px-4" onClick={submit} disabled={!input.trim() || busy}>
            Send
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-[10.5px] text-white/35">
          <span>{voiceSettings.pushToTalk ? "Push to talk" : "Hands-free"}</span>
          {voice.speaking && <button onClick={() => voice.stopSpeaking()} className="text-ruby-400">Stop speaking</button>}
        </div>
      </div>
    </div>
  );
}
