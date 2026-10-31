"use client";

import { useEffect, useRef, useState } from "react";
import { Emblem } from "./Emblem";

/**
 * WEIN launch sequence.
 *
 * A cinematic Japanese-inspired open: an ensō (円相) brush circle is drawn in one
 * continuous stroke, the WEIN wordmark resolves from it, and the mark contracts toward
 * the PHIRST2 avatar position before handing over to the app.
 *
 * The animation is pure canvas and runs once per session. It is skippable at any point,
 * and is bypassed entirely when the user prefers reduced motion.
 */

const SESSION_KEY = "wein.launch.shown";

export function LaunchSequence({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<"running" | "fading">("running");
  const finished = useRef(false);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    setPhase("fading");
    // Let the fade-out transition finish before unmounting.
    setTimeout(onDone, 620);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let start = 0;
    const DURATION = 2600;

    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);

    // A slightly irregular brush circle: the ensō is never a perfect ring.
    const wobble = (angle: number) =>
      1 + Math.sin(angle * 3 + 0.7) * 0.028 + Math.sin(angle * 7 + 2.1) * 0.014;

    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    const draw = (now: number) => {
      if (!start) start = now;
      const elapsed = now - start;
      const p = Math.min(1, elapsed / DURATION);

      const w = window.innerWidth;
      const h = window.innerHeight;
      const cx = w / 2;
      const cy = h / 2 - h * 0.04;
      const baseR = Math.min(w, h) * 0.19;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Deep graphite field, breathing very slightly.
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.8);
      bg.addColorStop(0, "#0a0d14");
      bg.addColorStop(1, "#04050a");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Phase 1 (0.00-0.62): the brush draws the ensō.
      const drawP = easeOut(Math.min(1, p / 0.62));
      const sweep = Math.PI * 1.86; // leaves the traditional small gap
      const startAngle = -Math.PI * 0.62;

      ctx.save();
      ctx.lineCap = "round";
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        const alpha = [0.5, 0.32, 0.16][layer]!;
        const width = [7.5, 13, 20][layer]!;
        ctx.strokeStyle = `rgba(212,184,120,${alpha * Math.min(1, p / 0.35)})`;
        ctx.lineWidth = width;
        ctx.shadowColor = "rgba(212,184,120,0.4)";
        ctx.shadowBlur = layer === 0 ? 18 : 0;
        const steps = 140;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          if (t > drawP) break;
          const a = startAngle + sweep * t;
          const r = baseR * wobble(a) * (1 - t * 0.035);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Phase 2 (0.34-1.0): the wordmark resolves out of the stroke.
      const textP = Math.max(0, Math.min(1, (p - 0.34) / 0.5));
      if (textP > 0) {
        const alpha = easeOut(textP);
        // A very slight vertical drift gives the wordmark weight.
        const rise = (1 - alpha) * 14;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const size = Math.min(78, w * 0.19);
        ctx.font = `600 ${size}px ui-serif, Georgia, "Times New Roman", serif`;
        ctx.letterSpacing = `${size * 0.14}px`;

        // Champagne gradient fill.
        const grad = ctx.createLinearGradient(cx - size * 2, cy, cx + size * 2, cy);
        grad.addColorStop(0, "#f4e4bc");
        grad.addColorStop(0.5, "#e8d5a3");
        grad.addColorStop(1, "#b89a5c");
        ctx.fillStyle = grad;
        ctx.globalAlpha = alpha;
        ctx.shadowColor = "rgba(212,184,120,0.35)";
        ctx.shadowBlur = 26;
        ctx.fillText("WEIN", cx, cy + rise);

        // Hairline rules flanking the wordmark, drawn outward from the centre.
        const ruleP = Math.max(0, Math.min(1, (p - 0.6) / 0.4));
        const y = cy + size * 0.72;
        if (ruleP > 0) {
          const ruleW = Math.min(w * 0.3, 150) * easeOut(ruleP);
          ctx.globalAlpha = alpha * ruleP;
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "rgba(212,184,120,0.5)";
          ctx.lineWidth = 1;
          for (const dir of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(cx + dir * size * 1.1, y);
            ctx.lineTo(cx + dir * (size * 1.1 + ruleW), y);
            ctx.stroke();
          }
        }

        // The tagline, last.
        const tagP = Math.max(0, Math.min(1, (p - 0.74) / 0.26));
        if (tagP > 0) {
          ctx.globalAlpha = alpha * tagP;
          ctx.shadowBlur = 0;
          ctx.font = `400 ${Math.min(13, w * 0.033)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.letterSpacing = "3px";
          ctx.fillStyle = "rgba(233,236,242,0.5)";
          ctx.fillText("CALM IN EXECUTION", cx, y + 26);
        }
        ctx.restore();
      }

      // Phase 3 (0.82-1.0): the ensō contracts toward the floating avatar's corner.
      const collapseP = Math.max(0, Math.min(1, (p - 0.82) / 0.18));
      if (collapseP > 0) {
        const toX = w - 44;
        const toY = h - 52;
        const r = baseR * 0.14 * (1 - collapseP) + 6;
        const x = cx + (toX - cx) * easeOut(collapseP);
        const y = cy + (toY - cy) * easeOut(collapseP);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, Math.max(r, 1), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(61,220,151,${0.85 * (1 - collapseP * 0.4)})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = "rgba(61,220,151,0.6)";
        ctx.shadowBlur = 22;
        ctx.stroke();
        ctx.restore();
      }

      if (p >= 1) {
        finish();
        return;
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
    // finish is stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="presentation"
      onClick={finish}
      className={`fixed inset-0 z-[200] cursor-pointer transition-opacity duration-[600ms] ${phase === "fading" ? "opacity-0" : "opacity-100"}`}
    >
      <canvas ref={canvasRef} />
      {/* The crystal emblem settles above the wordmark as the ensō resolves. */}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 transition-all duration-[900ms] ease-out ${
          phase === "fading" ? "opacity-0" : "opacity-100"
        }`}
        style={{ transform: `translate(-50%, calc(-50% - ${Math.min(150, (typeof window !== "undefined" ? Math.min(window.innerWidth, window.innerHeight) : 800) * 0.2)}px))` }}
      >
        <Emblem size={64} glow />
      </div>
      <button
        onClick={finish}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full border border-white/12 bg-white/5 px-5 py-2 text-[11.5px] font-medium text-white/60 backdrop-blur active:scale-95"
      >
        Skip
      </button>
    </div>
  );
}

/** Whether the launch sequence should run for this session. */
export function shouldLaunch(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    return sessionStorage.getItem(SESSION_KEY) !== "1";
  } catch {
    return true;
  }
}

export function markLaunched(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    /* private mode: the sequence simply runs again next load */
  }
}
