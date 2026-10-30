"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/api";

export type IndicatorKey = "ema" | "sma" | "bollinger" | "rsi" | "volume";

export interface ChartProps {
  candles: Candle[];
  indicators: IndicatorKey[];
  height?: number;
  /** Bumped by the parent whenever a new candle arrives, to trigger a redraw. */
  revision?: number;
}

interface Point { x: number; y: number }

function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Canvas candlestick chart. Deliberately dependency-free: it draws the real candle
 * data supplied by the API and overlays the indicators the user selects.
 */
export function Chart({ candles, indicators, height = 300, revision = 0 }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 360;
      setWidth(Math.max(280, Math.floor(w)));
    });
    ro.observe(el);
    setWidth(Math.max(280, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const series = useMemo(() => {
    const closes = candles.map((c) => c.close);
    return {
      closes,
      ema12: indicators.includes("ema") ? ema(closes, 12) : null,
      ema26: indicators.includes("ema") ? ema(closes, 26) : null,
      sma20: indicators.includes("sma") ? sma(closes, 20) : null,
      bb: indicators.includes("bollinger")
        ? (() => {
            const mid = sma(closes, 20);
            const upper: Array<number | null> = new Array(closes.length).fill(null);
            const lower: Array<number | null> = new Array(closes.length).fill(null);
            for (let i = 19; i < closes.length; i++) {
              const window = closes.slice(i - 19, i + 1);
              const m = mid[i]!;
              const sd = Math.sqrt(window.reduce((a, v) => a + (v - m) ** 2, 0) / window.length);
              upper[i] = m + 2 * sd;
              lower[i] = m - 2 * sd;
            }
            return { mid, upper, lower };
          })()
        : null,
      rsi: indicators.includes("rsi") ? rsi(closes, 14) : null,
    };
  }, [candles, indicators]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const showRsi = Boolean(series.rsi);
    const rsiHeight = showRsi ? 56 : 0;
    const gap = showRsi ? 10 : 0;
    const priceHeight = height - rsiHeight - gap;
    const padTop = 12;
    const padBottom = 18;
    const padLeft = 6;
    const padRight = 58;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (candles.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "13px -apple-system, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for market data…", width / 2, height / 2);
      return;
    }

    // Horizontal grid.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padTop + ((priceHeight - padTop - padBottom) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
    }

    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const overlayValues: number[] = [];
    if (series.bb) for (const v of [...series.bb.upper, ...series.bb.lower]) if (v !== null) overlayValues.push(v);
    const rawMax = Math.max(...highs, ...overlayValues);
    const rawMin = Math.min(...lows, ...overlayValues);
    const span = rawMax - rawMin || 1;
    const max = rawMax + span * 0.06;
    const min = rawMin - span * 0.06;

    const plotWidth = width - padLeft - padRight;
    const step = plotWidth / candles.length;
    const bodyWidth = Math.max(1.2, Math.min(step * 0.62, 13));
    const toY = (v: number) => padTop + ((max - v) / (max - min)) * (priceHeight - padTop - padBottom);
    const toX = (i: number) => padLeft + step * (i + 0.5);

    // Bollinger band fill.
    if (series.bb) {
      const pts: Point[] = [];
      for (let i = 0; i < candles.length; i++) if (series.bb.upper[i] !== null) pts.push({ x: toX(i), y: toY(series.bb.upper[i]!) });
      for (let i = candles.length - 1; i >= 0; i--) if (series.bb.lower[i] !== null) pts.push({ x: toX(i), y: toY(series.bb.lower[i]!) });
      if (pts.length > 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0]!.x, pts[0]!.y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fillStyle = "rgba(212,184,120,0.07)";
        ctx.fill();
        ctx.strokeStyle = "rgba(212,184,120,0.32)";
        ctx.lineWidth = 1;
        for (const key of ["upper", "lower"] as const) {
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < candles.length; i++) {
            const v = series.bb[key][i];
            if (v === null) continue;
            if (!started) { ctx.moveTo(toX(i), toY(v)); started = true; } else ctx.lineTo(toX(i), toY(v));
          }
          ctx.stroke();
        }
      }
    }

    // Candles: emerald for up, ruby for down.
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]!;
      const up = c.close >= c.open;
      const color = up ? "#3ddc97" : "#ff5c7a";
      const x = toX(i);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, toY(c.high));
      ctx.lineTo(x, toY(c.low));
      ctx.stroke();
      const yo = toY(c.open);
      const yc = toY(c.close);
      const top = Math.min(yo, yc);
      const h = Math.max(1, Math.abs(yc - yo));
      ctx.globalAlpha = up ? 0.95 : 0.9;
      ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, h);
      ctx.globalAlpha = 1;
    }

    // Overlays.
    const drawLine = (values: Array<number | null>, color: string, lineWidth = 1.4) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      let started = false;
      for (let i = 0; i < candles.length; i++) {
        const v = values[i];
        if (v === null || v === undefined) continue;
        if (!started) { ctx.moveTo(toX(i), toY(v)); started = true; } else ctx.lineTo(toX(i), toY(v));
      }
      ctx.stroke();
    };
    if (series.ema12) drawLine(series.ema12, "rgba(61,220,151,0.85)");
    if (series.ema26) drawLine(series.ema26, "rgba(244,228,188,0.8)");
    if (series.sma20) drawLine(series.sma20, "rgba(120,170,255,0.8)");
    if (series.bb) drawLine(series.bb.mid, "rgba(255,255,255,0.22)", 1);

    // Price axis.
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = max - ((max - min) * i) / 4;
      const y = padTop + ((priceHeight - padTop - padBottom) * i) / 4;
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.fillText(v.toFixed(2), width - padRight + 6, y);
    }

    // RSI sub-panel.
    if (showRsi && series.rsi) {
      const top = priceHeight + gap;
      const h = rsiHeight;
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(padLeft, top, plotWidth, h);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      for (const level of [30, 50, 70]) {
        const y = top + h - (level / 100) * h;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.strokeStyle = "rgba(212,184,120,0.9)";
      ctx.lineWidth = 1.3;
      let started = false;
      for (let i = 0; i < candles.length; i++) {
        const v = series.rsi[i];
        if (v === null || v === undefined) continue;
        const y = top + h - (v / 100) * h;
        if (!started) { ctx.moveTo(toX(i), y); started = true; } else ctx.lineTo(toX(i), y);
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      ctx.textAlign = "left";
      ctx.fillText("RSI 14", padLeft + 4, top + 8);
    }

    // Last price marker.
    const last = candles[candles.length - 1]!;
    const lastY = toY(last.close);
    const prev = candles[candles.length - 2];
    const rising = !prev || last.close >= prev.close;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = rising ? "rgba(61,220,151,0.55)" : "rgba(255,92,122,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, lastY);
    ctx.lineTo(width - padRight, lastY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Crosshair.
    if (hover && hover.index >= 0 && hover.index < candles.length) {
      const hx = toX(hover.index);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, height - padBottom);
      ctx.stroke();
      const hc = candles[hover.index]!;
      const label = `${hc.close.toFixed(2)}`;
      ctx.font = "10px ui-monospace, monospace";
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(212,184,120,0.92)";
      ctx.fillRect(width - padRight + 2, toY(hc.close) - 8, w, 16);
      ctx.fillStyle = "#0a0c12";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, width - padRight + 7, toY(hc.close));
    }
  }, [candles, series, width, height, hover, revision]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padLeft = 6;
    const padRight = 58;
    const plotWidth = width - padLeft - padRight;
    const step = plotWidth / Math.max(candles.length, 1);
    const index = Math.floor((x - padLeft) / step);
    if (index >= 0 && index < candles.length) setHover({ index, x, y: e.clientY - rect.top });
    else setHover(null);
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="w-full touch-pan-y"
        style={{ height }}
      />
      {hover && candles[hover.index] && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-xl border border-white/10 bg-black/80 px-2.5 py-1.5 text-[10px] leading-tight backdrop-blur">
          <div className="mono-num text-white/80">
            O {candles[hover.index]!.open.toFixed(2)} H {candles[hover.index]!.high.toFixed(2)}
          </div>
          <div className="mono-num text-white/80">
            L {candles[hover.index]!.low.toFixed(2)} C {candles[hover.index]!.close.toFixed(2)}
          </div>
          <div className="mono-num text-white/40">
            {new Date(candles[hover.index]!.epoch * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      )}
    </div>
  );
}
