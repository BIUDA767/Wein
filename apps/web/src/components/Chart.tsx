"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/api";

export type IndicatorKey = "ema" | "sma" | "bollinger" | "rsi" | "macd" | "stochastic" | "cci";
export type ChartStyle = "candles" | "hollow" | "line" | "area";
export type DrawingTool = "none" | "trendline" | "hline" | "rect" | "text";

/** A trade or signal marked on the price axis. */
export interface ChartMarker {
  id: string;
  kind: "entry" | "exit" | "signal" | "expiry";
  epoch: number;
  price: number;
  side?: "buy" | "sell";
  pnl?: number | null;
  origin?: string;
  label?: string;
  /** True for an expected (not yet realised) exit or expiry. */
  projected?: boolean;
}

export interface ChartLine {
  id: string;
  kind: "entry" | "stop" | "target";
  price: number;
  label: string;
}

export interface ChartDrawing {
  id: string;
  tool: Exclude<DrawingTool, "none">;
  a: { epoch: number; price: number };
  b?: { epoch: number; price: number };
  text?: string;
}

export interface ChartProps {
  candles: Candle[];
  indicators: IndicatorKey[];
  height?: number;
  revision?: number;
  chartStyle?: ChartStyle;
  grid?: boolean;
  markers?: ChartMarker[];
  lines?: ChartLine[];
  drawings?: ChartDrawing[];
  onDrawingsChange?: (d: ChartDrawing[]) => void;
  onMarkerClick?: (m: ChartMarker) => void;
  /** True when market data is genuinely unavailable; draws axes but no candles. */
  disconnected?: boolean;
  disconnectedReason?: string;
}

interface View { start: number; end: number }

const GREEN = "#00c853";
const RED = "#ff3b30";
const GOLD = "#d4af37";
const CYAN = "#3ddcff";

function smaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiSeries(values: number[], period = 14): Array<number | null> {
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

function macdSeries(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macdLine: Array<number | null> = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f === null || s === null ? null : f - s;
  });
  const defined = macdLine.filter((v): v is number => v !== null);
  const sig = emaSeries(defined, signalPeriod);
  const signalLine: Array<number | null> = new Array(values.length).fill(null);
  let si = 0;
  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] === null) continue;
    signalLine[i] = sig[si++] ?? null;
  }
  const histogram: Array<number | null> = values.map((_, i) => {
    const m = macdLine[i];
    const s = signalLine[i];
    return m === null || s === null ? null : m - s;
  });
  return { macdLine, signalLine, histogram };
}

function stochasticSeries(candles: Candle[], period = 14, smoothD = 3) {
  const k: Array<number | null> = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...window.map((c) => c.high));
    const ll = Math.min(...window.map((c) => c.low));
    k[i] = hh === ll ? 50 : ((candles[i]!.close - ll) / (hh - ll)) * 100;
  }
  const defined = k.filter((v): v is number => v !== null);
  const dSeries = smaSeries(defined, smoothD);
  const d: Array<number | null> = new Array(candles.length).fill(null);
  let di = 0;
  for (let i = 0; i < candles.length; i++) {
    if (k[i] === null) continue;
    d[i] = dSeries[di++] ?? null;
  }
  return { k, d };
}

function cciSeries(candles: Candle[], period = 20) {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const out: Array<number | null> = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const window = tp.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const md = window.reduce((a, v) => a + Math.abs(v - mean), 0) / period;
    out[i] = md === 0 ? 0 : (tp[i]! - mean) / (0.015 * md);
  }
  return out;
}

/**
 * Professional canvas chart. Draws only the candle data supplied by the API.
 *
 * When no data is available it draws the grid, price axis and time axis and a
 * connection notice — never invented candles. Zoom, pan and drawings operate in
 * data space so they survive new data arriving.
 */
export function Chart({
  candles,
  indicators,
  height = 320,
  revision = 0,
  chartStyle = "candles",
  grid = true,
  markers = [],
  lines = [],
  drawings = [],
  onDrawingsChange,
  onMarkerClick,
  disconnected = false,
  disconnectedReason,
}: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);
  const [view, setView] = useState<View>({ start: 0, end: 1 });
  const [tool, setTool] = useState<DrawingTool>("none");
  const [pending, setPending] = useState<{ epoch: number; price: number } | null>(null);
  const dragRef = useRef<{ x: number; startView: View } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(280, Math.floor(entries[0]?.contentRect.width ?? 360))));
    ro.observe(el);
    setWidth(Math.max(280, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  // Reset the window whenever the dataset changes shape (new symbol or timeframe).
  const candleKey = `${candles.length ? candles[0]!.epoch : 0}:${candles.length}`;
  useEffect(() => { setView({ start: 0, end: 1 }); }, [candleKey]);

  const series = useMemo(() => {
    const closes = candles.map((c) => c.close);
    const show = (k: IndicatorKey) => indicators.includes(k);
    return {
      closes,
      ema12: show("ema") ? emaSeries(closes, 12) : null,
      ema26: show("ema") ? emaSeries(closes, 26) : null,
      sma20: show("sma") ? smaSeries(closes, 20) : null,
      bb: show("bollinger")
        ? (() => {
            const mid = smaSeries(closes, 20);
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
      rsi: show("rsi") ? rsiSeries(closes, 14) : null,
      macd: show("macd") ? macdSeries(closes) : null,
      stoch: show("stochastic") ? stochasticSeries(candles) : null,
      cci: show("cci") ? cciSeries(candles) : null,
    };
  }, [candles, indicators]);

  // Oscillator panes drawn beneath the price pane.
  const subPanels = useMemo(() => {
    const panes: Array<{ key: "rsi" | "macd" | "stochastic" | "cci"; height: number }> = [];
    if (series.rsi) panes.push({ key: "rsi", height: 52 });
    if (series.macd) panes.push({ key: "macd", height: 52 });
    if (series.stoch) panes.push({ key: "stochastic", height: 52 });
    if (series.cci) panes.push({ key: "cci", height: 52 });
    return panes;
  }, [series]);

  const geometry = useMemo(() => {
    const padTop = 12;
    const padBottom = 18;
    const padLeft = 6;
    const padRight = 58;
    const subTotal = subPanels.reduce((a, p) => a + p.height + 8, 0);
    const priceHeight = Math.max(80, height - subTotal - padTop - padBottom);
    return { padTop, padBottom, padLeft, padRight, priceHeight, subTotal };
  }, [height, subPanels]);

  const visible = useMemo(() => {
    if (candles.length === 0) return { slice: [] as Candle[], from: 0 };
    const from = Math.max(0, Math.min(Math.floor(view.start * candles.length), Math.max(0, candles.length - 2)));
    const to = Math.max(from + 2, Math.min(Math.ceil(view.end * candles.length), candles.length));
    return { slice: candles.slice(from, to), from };
  }, [candles, view]);

  const toY = useCallback(
    (v: number, max: number, min: number) =>
      geometry.padTop + ((max - v) / (max - min || 1)) * (geometry.priceHeight - geometry.padTop - geometry.padBottom),
    [geometry],
  );

  const priceRange = useMemo(() => {
    const s = visible.slice;
    if (s.length === 0) return { max: 1, min: 0 };
    const values: number[] = [];
    for (const c of s) values.push(c.high, c.low);
    if (series.bb) {
      for (let i = visible.from; i < visible.from + s.length; i++) {
        const u = series.bb.upper[i];
        const l = series.bb.lower[i];
        if (u != null) values.push(u);
        if (l != null) values.push(l);
      }
    }
    for (const ln of lines) values.push(ln.price);
    for (const d of drawings) { values.push(d.a.price); if (d.b) values.push(d.b.price); }
    const rawMax = Math.max(...values);
    const rawMin = Math.min(...values);
    const span = rawMax - rawMin || 1;
    return { max: rawMax + span * 0.07, min: rawMin - span * 0.07 };
  }, [visible, series.bb, lines, drawings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { padTop, padBottom, padLeft, padRight, priceHeight } = geometry;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const plotWidth = width - padLeft - padRight;
    const plotBottom = priceHeight - padBottom;
    const s = visible.slice;
    const { max, min } = priceRange;
    const n = Math.max(s.length, 1);
    const step = plotWidth / n;
    const toX = (i: number) => padLeft + step * (i + 0.5);
    const y = (v: number) => toY(v, max, min);

    // Grid is drawn even with no data, so the chart never looks broken.
    if (grid) {
      ctx.strokeStyle = "rgba(255,255,255,0.055)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const gy = padTop + ((priceHeight - padTop - padBottom) * i) / 4;
        ctx.beginPath(); ctx.moveTo(padLeft, gy); ctx.lineTo(width - padRight, gy); ctx.stroke();
      }
      for (let i = 0; i <= 5; i++) {
        const gx = padLeft + (plotWidth * i) / 5;
        ctx.beginPath(); ctx.moveTo(gx, padTop); ctx.lineTo(gx, plotBottom); ctx.stroke();
      }
    }

    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const gy = padTop + ((priceHeight - padTop - padBottom) * i) / 4;
      if (s.length > 0) {
        const v = max - ((max - min) * i) / 4;
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.fillText(v.toFixed(2), width - padRight + 6, gy);
      } else {
        // Placeholder ticks: a real price would be a fabrication.
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.fillRect(width - padRight + 6, gy - 1, 30, 2);
      }
    }

    if (s.length === 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "600 13px -apple-system, system-ui, sans-serif";
      ctx.fillText(disconnected ? "Market data not connected" : "Waiting for market data…", width / 2, height / 2 - 8);
      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.34)";
      ctx.fillText(
        disconnectedReason ?? "Connect a broker to stream live prices. No candles are drawn until real data arrives.",
        width / 2,
        height / 2 + 12,
      );
      return;
    }

    if (series.bb) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < s.length; i++) {
        const v = series.bb.upper[visible.from + i];
        if (v == null) continue;
        const px = toX(i);
        const py = y(v);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      for (let i = s.length - 1; i >= 0; i--) {
        const v = series.bb.lower[visible.from + i];
        if (v == null) continue;
        ctx.lineTo(toX(i), y(v));
      }
      if (started) {
        ctx.closePath();
        ctx.fillStyle = "rgba(212,175,55,0.06)";
        ctx.fill();
        ctx.strokeStyle = "rgba(212,175,55,0.3)";
        ctx.lineWidth = 1;
        for (const key of ["upper", "lower"] as const) {
          ctx.beginPath();
          let st = false;
          for (let i = 0; i < s.length; i++) {
            const v = series.bb[key][visible.from + i];
            if (v == null) continue;
            if (!st) { ctx.moveTo(toX(i), y(v)); st = true; } else ctx.lineTo(toX(i), y(v));
          }
          ctx.stroke();
        }
      }
    }

    if (chartStyle === "line" || chartStyle === "area") {
      const path = new Path2D();
      for (let i = 0; i < s.length; i++) {
        const px = toX(i);
        const py = y(s[i]!.close);
        if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
      }
      if (chartStyle === "area") {
        const fill = new Path2D(path);
        fill.lineTo(toX(s.length - 1), plotBottom);
        fill.lineTo(toX(0), plotBottom);
        fill.closePath();
        const grad = ctx.createLinearGradient(0, padTop, 0, plotBottom);
        grad.addColorStop(0, "rgba(0,200,83,0.24)");
        grad.addColorStop(1, "rgba(0,200,83,0)");
        ctx.fillStyle = grad;
        ctx.fill(fill);
      }
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.stroke(path);
    } else {
      const bodyWidth = Math.max(1.2, Math.min(step * 0.62, 13));
      for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        const up = c.close >= c.open;
        const color = up ? GREEN : RED;
        const px = toX(i);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, y(c.high));
        ctx.lineTo(px, y(c.low));
        ctx.stroke();
        const top = Math.min(y(c.open), y(c.close));
        const h = Math.max(1, Math.abs(y(c.close) - y(c.open)));
        if (chartStyle === "hollow") {
          ctx.globalAlpha = 0.5;
          ctx.fillRect(px - bodyWidth / 2, top, bodyWidth, h);
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.1;
          ctx.strokeRect(px - bodyWidth / 2, top, bodyWidth, h);
        } else {
          ctx.fillRect(px - bodyWidth / 2, top, bodyWidth, h);
        }
      }
    }

    const drawSeries = (values: Array<number | null>, color: string, lw = 1.4) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      let st = false;
      for (let i = 0; i < s.length; i++) {
        const v = values[visible.from + i];
        if (v == null) continue;
        if (!st) { ctx.moveTo(toX(i), y(v)); st = true; } else ctx.lineTo(toX(i), y(v));
      }
      ctx.stroke();
    };
    if (series.ema12) drawSeries(series.ema12, "rgba(0,200,83,0.85)");
    if (series.ema26) drawSeries(series.ema26, "rgba(212,175,55,0.8)");
    if (series.sma20) drawSeries(series.sma20, "rgba(120,170,255,0.8)");
    if (series.bb) drawSeries(series.bb.mid, "rgba(255,255,255,0.2)", 1);

    // Position lines: entry, stop, target.
    for (const ln of lines) {
      const ly = y(ln.price);
      if (ly < padTop || ly > plotBottom) continue;
      ctx.setLineDash(ln.kind === "entry" ? [] : [5, 4]);
      ctx.strokeStyle = ln.kind === "entry" ? "rgba(255,255,255,0.5)" : ln.kind === "stop" ? "rgba(255,59,48,0.65)" : "rgba(0,200,83,0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, ly);
      ctx.lineTo(width - padRight, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(ln.label, padLeft + 4, ly - 7);
    }

    // Epoch -> local candle index, used by drawings and markers.
    const perCandle = candles.length > 1 ? (candles[1]!.epoch - candles[0]!.epoch) || 1 : 1;
    const baseEpoch = candles[visible.from]?.epoch ?? 0;
    const epochToIndex = (epoch: number) => (epoch - baseEpoch) / perCandle;

    for (const d of drawings) {
      const ax = toX(epochToIndex(d.a.epoch));
      const ay = y(d.a.price);
      ctx.strokeStyle = "rgba(61,220,255,0.85)";
      ctx.fillStyle = "rgba(61,220,255,0.9)";
      ctx.lineWidth = 1.4;
      if (d.tool === "hline") {
        ctx.beginPath(); ctx.moveTo(padLeft, ay); ctx.lineTo(width - padRight, ay); ctx.stroke();
      } else if (d.b) {
        const bx = toX(epochToIndex(d.b.epoch));
        const by = y(d.b.price);
        if (d.tool === "trendline") {
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        } else if (d.tool === "rect") {
          ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        } else if (d.tool === "text") {
          ctx.font = "11px -apple-system, system-ui, sans-serif";
          ctx.fillText(d.text ?? "note", ax, ay);
        }
      }
    }

    // Trade and signal markers.
    for (const m of markers) {
      const mi = epochToIndex(m.epoch);
      if (mi < -0.5 || mi > s.length + 0.5) continue;
      const mx = toX(mi);
      const my = y(m.price);
      if (my < padTop - 2 || my > plotBottom + 2) continue;

      if (m.kind === "entry" || m.kind === "exit" || m.kind === "expiry") {
        const profitable = m.pnl == null ? null : m.pnl >= 0;
        const color = m.kind === "expiry" ? GOLD : profitable === null ? (m.side === "buy" ? GREEN : RED) : profitable ? GREEN : RED;
        ctx.globalAlpha = m.projected ? 0.55 : 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (m.kind === "expiry") {
          ctx.moveTo(mx, my - 5); ctx.lineTo(mx + 5, my); ctx.lineTo(mx, my + 5); ctx.lineTo(mx - 5, my); ctx.closePath();
        } else if (m.kind === "entry") {
          ctx.moveTo(mx, my + 6); ctx.lineTo(mx - 5, my - 3); ctx.lineTo(mx + 5, my - 3); ctx.closePath();
        } else {
          ctx.moveTo(mx, my - 6); ctx.lineTo(mx - 5, my + 3); ctx.lineTo(mx + 5, my + 3); ctx.closePath();
        }
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // Automated trades carry a small cyan ring so they are distinguishable.
        if (m.origin && m.origin !== "manual") {
          ctx.beginPath();
          ctx.arc(mx, my, 8, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(61,220,255,0.6)";
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.arc(mx, my, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = CYAN;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(mx, my, 6, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(61,220,255,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Last price marker.
    const last = s[s.length - 1]!;
    const lastY = y(last.close);
    const prev = s[s.length - 2];
    const rising = !prev || last.close >= prev.close;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = rising ? "rgba(0,200,83,0.5)" : "rgba(255,59,48,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, lastY);
    ctx.lineTo(width - padRight, lastY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (hover && hover.index >= 0 && hover.index < candles.length) {
      const localIdx = hover.index - visible.from;
      if (localIdx >= 0 && localIdx < s.length) {
        const hx = toX(localIdx);
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.beginPath();
        ctx.moveTo(hx, padTop);
        ctx.lineTo(hx, height - padBottom);
        ctx.stroke();
      }
    }

    let panelTop = priceHeight + 8;
    for (const panel of subPanels) {
      const ph = panel.height;
      ctx.fillStyle = "rgba(255,255,255,0.018)";
      ctx.fillRect(padLeft, panelTop, plotWidth, ph);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;

      const panelLine = (values: Array<number | null>, toPy: (v: number) => number, color: string) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        let st = false;
        for (let i = 0; i < s.length; i++) {
          const v = values[visible.from + i];
          if (v == null) continue;
          if (!st) { ctx.moveTo(toX(i), toPy(v)); st = true; } else ctx.lineTo(toX(i), toPy(v));
        }
        ctx.stroke();
      };

      if (panel.key === "rsi" && series.rsi) {
        for (const level of [30, 50, 70]) {
          const ly = panelTop + ph - (level / 100) * ph;
          ctx.beginPath(); ctx.moveTo(padLeft, ly); ctx.lineTo(width - padRight, ly); ctx.stroke();
        }
        panelLine(series.rsi, (v) => panelTop + ph - (v / 100) * ph, GOLD);
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText("RSI 14", padLeft + 4, panelTop + 8);
      } else if (panel.key === "macd" && series.macd) {
        const vals = [...series.macd.macdLine, ...series.macd.signalLine, ...series.macd.histogram].filter((v): v is number => v !== null);
        const amp = Math.max(...vals.map(Math.abs)) || 1;
        const zero = panelTop + ph / 2;
        ctx.beginPath(); ctx.moveTo(padLeft, zero); ctx.lineTo(width - padRight, zero); ctx.stroke();
        for (let i = 0; i < s.length; i++) {
          const v = series.macd.histogram[visible.from + i];
          if (v == null) continue;
          const h = (v / amp) * (ph / 2 - 2);
          ctx.fillStyle = v >= 0 ? "rgba(0,200,83,0.5)" : "rgba(255,59,48,0.5)";
          ctx.fillRect(toX(i) - 1.5, zero, 3, -h);
        }
        panelLine(series.macd.macdLine, (v) => zero - (v / amp) * (ph / 2 - 2), "rgba(61,220,255,0.9)");
        panelLine(series.macd.signalLine, (v) => zero - (v / amp) * (ph / 2 - 2), "rgba(212,175,55,0.9)");
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText("MACD 12 26 9", padLeft + 4, panelTop + 8);
      } else if (panel.key === "stochastic" && series.stoch) {
        for (const level of [20, 80]) {
          const ly = panelTop + ph - (level / 100) * ph;
          ctx.beginPath(); ctx.moveTo(padLeft, ly); ctx.lineTo(width - padRight, ly); ctx.stroke();
        }
        panelLine(series.stoch.k, (v) => panelTop + ph - (v / 100) * ph, "rgba(61,220,255,0.9)");
        panelLine(series.stoch.d, (v) => panelTop + ph - (v / 100) * ph, "rgba(212,175,55,0.9)");
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText("STOCH 14 3", padLeft + 4, panelTop + 8);
      } else if (panel.key === "cci" && series.cci) {
        const amp = 200;
        const mid = panelTop + ph / 2;
        ctx.beginPath(); ctx.moveTo(padLeft, mid); ctx.lineTo(width - padRight, mid); ctx.stroke();
        panelLine(series.cci, (v) => mid - (Math.max(-amp, Math.min(amp, v)) / amp) * (ph / 2 - 2), "rgba(61,220,255,0.9)");
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillText("CCI 20", padLeft + 4, panelTop + 8);
      }
      panelTop += ph + 8;
    }

    // Time axis labels.
    ctx.fillStyle = "rgba(255,255,255,0.36)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    const labelEvery = Math.max(1, Math.floor(s.length / 5));
    for (let i = 0; i < s.length; i += labelEvery) {
      const d = new Date(s[i]!.epoch * 1000);
      ctx.fillText(d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), toX(i), height - 6);
    }
  }, [candles, series, visible, width, height, hover, revision, chartStyle, grid, geometry, priceRange, markers, lines, drawings, disconnected, disconnectedReason, subPanels, toY]);

  const hitMarker = useCallback(
    (x: number, yPos: number): ChartMarker | null => {
      const s = visible.slice;
      if (s.length === 0) return null;
      const plotWidth = width - geometry.padLeft - geometry.padRight;
      const step = plotWidth / s.length;
      const { max, min } = priceRange;
      const base = candles[visible.from]?.epoch ?? 0;
      const per = candles.length > 1 ? (candles[1]!.epoch - candles[0]!.epoch) || 1 : 1;
      for (const m of markers) {
        const mi = (m.epoch - base) / per;
        const mx = geometry.padLeft + step * (mi + 0.5);
        const my = toY(m.price, max, min);
        if (Math.hypot(mx - x, my - yPos) < 14) return m;
      }
      return null;
    },
    [markers, visible, width, geometry, priceRange, toY, candles],
  );

  const dataAt = useCallback(
    (x: number, yPos: number) => {
      const s = visible.slice;
      const plotWidth = width - geometry.padLeft - geometry.padRight;
      const step = plotWidth / Math.max(s.length, 1);
      const idx = Math.floor((x - geometry.padLeft) / step);
      const clamped = Math.max(0, Math.min(idx, s.length - 1));
      const candle = s[clamped];
      const { max, min } = priceRange;
      const price = max - ((yPos - geometry.padTop) / (geometry.priceHeight - geometry.padTop - geometry.padBottom)) * (max - min);
      return { epoch: candle?.epoch ?? Math.floor(Date.now() / 1000), price, index: visible.from + clamped };
    },
    [visible, width, geometry, priceRange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yPos = e.clientY - rect.top;
    const m = hitMarker(x, yPos);
    if (m && onMarkerClick) {
      onMarkerClick(m);
      return;
    }
    if (tool === "none") {
      dragRef.current = { x, startView: view };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const at = dataAt(x, yPos);
    if (tool === "hline") {
      onDrawingsChange?.([...drawings, { id: `d${Date.now()}`, tool, a: { epoch: at.epoch, price: at.price } }]);
      return;
    }
    if (!pending) {
      setPending({ epoch: at.epoch, price: at.price });
    } else {
      const text = tool === "text" ? window.prompt("Annotation text", "") ?? "note" : undefined;
      onDrawingsChange?.([...drawings, { id: `d${Date.now()}`, tool, a: pending, b: { epoch: at.epoch, price: at.price }, text }]);
      setPending(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yPos = e.clientY - rect.top;

    const drag = dragRef.current;
    if (drag && tool === "none") {
      const plotWidth = width - geometry.padLeft - geometry.padRight;
      const perPx = (view.end - view.start) / plotWidth;
      const delta = -(x - drag.x) * perPx;
      let start = drag.startView.start + delta;
      let end = drag.startView.end + delta;
      if (start < 0) { end -= start; start = 0; }
      if (end > 1) { start -= end - 1; end = 1; }
      setView({ start: Math.max(0, start), end: Math.min(1, end) });
      return;
    }

    const s = visible.slice;
    const plotWidth = width - geometry.padLeft - geometry.padRight;
    const step = plotWidth / Math.max(s.length, 1);
    const index = visible.from + Math.floor((x - geometry.padLeft) / step);
    if (index >= 0 && index < candles.length) setHover({ index, x });
    else setHover(null);
  };

  const onPointerUp = () => { dragRef.current = null; };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    const mid = (view.start + view.end) / 2;
    let half = ((view.end - view.start) * factor) / 2;
    half = Math.max(0.04, Math.min(0.5, half));
    setView({ start: Math.max(0, mid - half), end: Math.min(1, mid + half) });
  };

  const zoom = (factor: number) => {
    const mid = (view.start + view.end) / 2;
    let half = ((view.end - view.start) * factor) / 2;
    half = Math.max(0.04, Math.min(0.5, half));
    setView({ start: Math.max(0, mid - half), end: Math.min(1, mid + half) });
  };

  const hoverCandle = hover && candles[hover.index] ? candles[hover.index] : null;

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setHover(null); dragRef.current = null; }}
        onWheel={onWheel}
        className="w-full touch-none select-none"
        style={{ height, cursor: tool === "none" ? "crosshair" : "copy" }}
      />

      {hoverCandle && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-xl border border-white/10 bg-black/80 px-2.5 py-1.5 text-[10px] leading-tight backdrop-blur">
          <div className="mono-num text-white/80">O {hoverCandle.open.toFixed(2)} H {hoverCandle.high.toFixed(2)}</div>
          <div className="mono-num text-white/80">L {hoverCandle.low.toFixed(2)} C {hoverCandle.close.toFixed(2)}</div>
          <div className="mono-num text-white/40">
            {new Date(hoverCandle.epoch * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      )}

      <div className="absolute bottom-2 left-2 flex items-center gap-1">
        {([
          { t: "none" as DrawingTool, label: "↕", title: "Pan and zoom" },
          { t: "trendline" as DrawingTool, label: "╱", title: "Trend line" },
          { t: "hline" as DrawingTool, label: "―", title: "Horizontal line" },
          { t: "rect" as DrawingTool, label: "▭", title: "Rectangle" },
          { t: "text" as DrawingTool, label: "T", title: "Text annotation" },
        ]).map((b) => (
          <button
            key={b.t}
            title={b.title}
            aria-label={b.title}
            onClick={() => { setTool(b.t); setPending(null); }}
            className={`flex h-7 w-7 items-center justify-center rounded-lg border text-[12px] backdrop-blur transition active:scale-95 ${
              tool === b.t ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-300" : "border-white/12 bg-black/60 text-white/60"
            }`}
          >
            {b.label}
          </button>
        ))}
        {drawings.length > 0 && (
          <button
            title="Clear drawings"
            aria-label="Clear drawings"
            onClick={() => onDrawingsChange?.([])}
            className="flex h-7 items-center rounded-lg border border-white/12 bg-black/60 px-2 text-[10px] text-white/60 backdrop-blur active:scale-95"
          >
            clear
          </button>
        )}
      </div>
      <div className="absolute bottom-2 right-2 flex items-center gap-1">
        <button aria-label="Zoom out" onClick={() => zoom(1.25)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/12 bg-black/60 text-[13px] text-white/60 backdrop-blur active:scale-95">−</button>
        <button aria-label="Zoom in" onClick={() => zoom(0.8)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/12 bg-black/60 text-[13px] text-white/60 backdrop-blur active:scale-95">+</button>
      </div>
    </div>
  );
}
