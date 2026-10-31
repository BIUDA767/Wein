"use client";

import { useEffect, useRef } from "react";
import { VISEME_SHAPES, type Viseme, type VisemeFrame } from "@/lib/visemes";

export type AvatarState = "idle" | "speaking" | "listening" | "thinking" | "alert";

/** The live speech timeline produced by `useVoice`, sampled each frame for lip-sync. */
export interface AvatarSpeechSource {
  current: {
    steps: Array<{ viseme: string; charIndex: number }>;
    anchorIndex: number;
    anchorTime: number;
    rate: number;
    active: boolean;
  };
}

interface AvatarProps {
  state: AvatarState;
  size?: number;
  onClick?: () => void;
  urgency?: "normal" | "attention" | "critical";
  speech?: AvatarSpeechSource;
  /** Optional audio amplitude 0-1, added on top of the timeline when available. */
  levelRef?: { current: number };
}

/**
 * PHIRST2 — a Japanese-inspired male digital human, rendered procedurally.
 *
 * There is no image or video asset. The face is drawn every frame from layered gradients:
 * skin volume, ambient occlusion, iris depth, hair mass and specular highlights. That
 * choice is deliberate — it keeps the avatar a few kilobytes instead of tens of megabytes,
 * scales to any size without blurring, and lets every expression be driven by real system
 * state rather than being locked into a pre-rendered clip.
 *
 * What is real here: the mouth follows the live viseme timeline from the speech engine
 * (see `lib/visemes.ts`), re-anchored on the engine's own word-boundary events, so it
 * tracks the actual utterance. Blinks, saccades, breathing, head sway and the state rings
 * are all functions of elapsed time and the avatar's real state.
 *
 * What it is not: a stylised real-time render, not a photoreal capture. Browsers expose no
 * raw audio for synthesised speech, so lip-sync is text-and-timing driven, not spectral.
 */
export function Avatar({ state, size = 72, onClick, urgency = "normal", speech, levelRef }: AvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const urgencyRef = useRef(urgency);
  stateRef.current = state;
  urgencyRef.current = urgency;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Render internally at a fixed high resolution, then scale to the CSS box: the face
    // stays crisp at any display size and never depends on the box for quality.
    const R = 360;
    canvas.width = R * dpr;
    canvas.height = R * dpr;

    let raf = 0;
    const t0 = performance.now();
    let blink = 0;
    let nextBlink = 1400 + Math.random() * 2600;
    let lastBlink = 0;
    let gazeX = 0;
    let gazeY = 0;
    let targetGazeX = 0;
    let targetGazeY = 0;
    let nextSaccade = 900 + Math.random() * 1600;
    let lastSaccade = 0;
    let breathPhase = Math.random() * Math.PI * 2;
    let headX = 0;
    let headY = 0;
    let headR = 0;
    let lastState = stateRef.current;
    let mouth: VisemeFrame = VISEME_SHAPES.sil;

    const ease = (a: number, b: number, k: number) => a + (b - a) * k;

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const s = stateRef.current;
      const u = urgencyRef.current;
      if (s !== lastState) lastState = s;

      const cx = R / 2;
      const cy = R / 2;
      const scale = R / 360;

      // --- Blink -------------------------------------------------------------
      if (now - lastBlink > nextBlink) {
        blink = 1;
        lastBlink = now;
        nextBlink = 1800 + Math.random() * 3400;
      }
      blink = Math.max(0, blink - 0.16);
      const blinkAmount = blink > 0 ? Math.sin(Math.min(1, blink) * Math.PI) : 0;

      // --- Saccades ----------------------------------------------------------
      if (now - lastSaccade > nextSaccade) {
        targetGazeX = (Math.random() - 0.5) * 0.5;
        targetGazeY = (Math.random() - 0.5) * 0.28;
        lastSaccade = now;
        nextSaccade = 700 + Math.random() * 2100;
      }
      gazeX = ease(gazeX, targetGazeX, 0.14);
      gazeY = ease(gazeY, targetGazeY, 0.14);

      // --- Breathing and head motion ----------------------------------------
      breathPhase += 0.014;
      const breath = Math.sin(breathPhase) * 0.5 + 0.5;
      // Two incommensurate frequencies never visibly loop.
      const swayX = Math.sin(t * 0.42) * 2.6 + Math.sin(t * 0.23 + 1.7) * 1.6;
      const swayY = Math.cos(t * 0.35) * 1.7 + Math.sin(t * 0.17 + 0.6) * 1.1;
      const tilt = Math.sin(t * 0.29 + 2.2) * 0.9;
      const speaking = s === "speaking";
      const nod = speaking ? Math.sin(t * 4.1) * 1.5 + Math.sin(t * 6.7) * 0.7 : 0;
      const listenLean = s === "listening" ? Math.sin(t * 1.6) * 1.2 : 0;
      headX = ease(headX, swayX + listenLean, 0.05);
      headY = ease(headY, swayY + nod + breath * 0.7, 0.05);
      headR = ease(headR, tilt, 0.04);

      // --- Mouth -------------------------------------------------------------
      let target: VisemeFrame = VISEME_SHAPES.sil;
      if (speaking && speech?.current.active && speech.current.steps.length > 0) {
        const sp = speech.current;
        const elapsed = now - sp.anchorTime;
        const idx = Math.min(
          sp.steps.length - 1,
          Math.max(0, sp.anchorIndex + Math.floor(elapsed * sp.rate)),
        );
        const step = sp.steps[idx];
        if (step && step.viseme in VISEME_SHAPES) {
          const base = VISEME_SHAPES[step.viseme as Viseme];
          // A gentle per-frame variation keeps the jaw from looking mechanical.
          const jitter = 1 + Math.sin(now * 0.021) * 0.06;
          target = { shape: base.shape, open: Math.min(1, base.open * jitter), spread: base.spread };
        }
      }
      // Faster attack when opening, slower release when closing: how mouths really move.
      const k = target.open > mouth.open ? 0.5 : 0.34;
      mouth = {
        shape: target.shape,
        open: ease(mouth.open, target.open, k),
        spread: ease(mouth.spread, target.spread, k),
      };
      const level = levelRef?.current ?? 0;
      const openness = Math.min(1, mouth.open * (1 + level * 0.35));

      // --- Expression --------------------------------------------------------
      const browRaise = s === "alert" ? 0.9 : s === "listening" ? 0.45 : s === "thinking" ? 0.2 : 0;
      const eyeOpen = s === "thinking" ? 0.62 : s === "alert" ? 1.12 : 1;
      const smile = s === "idle" ? 0.16 : s === "listening" ? 0.3 : speaking ? 0.22 : 0;

      const accent = u === "critical" ? [255, 92, 122] : u === "attention" ? [212, 184, 120] : [61, 220, 151];

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, R, R);

      // --- Background halo ---------------------------------------------------
      const halo = ctx.createRadialGradient(cx, cy - 8 * scale, 0, cx, cy - 8 * scale, R * 0.5);
      halo.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},0.20)`);
      halo.addColorStop(0.62, `rgba(${accent[0]},${accent[1]},${accent[2]},0.05)`);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
      ctx.fill();

      // --- Listening pulse ---------------------------------------------------
      if (s === "listening") {
        const pulse = 0.55 + Math.sin(t * 3.4) * 0.45;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.46, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},${0.28 + pulse * 0.4})`;
        ctx.lineWidth = 2.4 * scale;
        ctx.stroke();
        ctx.restore();
      }

      // The face group: everything below moves with the head. drawFigure works in a
      // 360-unit space centred on (180,180); recentring by -R/2 maps that space onto the
      // canvas so the head sits in the middle and sway/rotation pivot about the centre.
      ctx.save();
      ctx.translate(cx + headX * scale, cy + headY * scale);
      ctx.rotate((headR * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.translate(-R / 2, -R / 2);
      drawFigure(ctx, {
        t,
        breath,
        browRaise,
        eyeOpen,
        blinkAmount,
        gazeX,
        gazeY,
        smile,
        openness,
        spread: mouth.spread,
        speaking,
      });
      ctx.restore();

      // --- State ring --------------------------------------------------------
      if (s !== "idle") {
        const ringPulse = s === "listening" ? 0.6 + Math.sin(t * 3.4) * 0.4 : 0.55;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.472, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},${0.35 + ringPulse * 0.35})`;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.restore();
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [speech, levelRef]);

  const accent = urgency === "critical" ? "#ff5c7a" : urgency === "attention" ? "#d4b878" : "#3ddc97";

  return (
    <button
      onClick={onClick}
      aria-label={`PHIRST2 assistant, ${state}`}
      className="group relative shrink-0 rounded-full outline-none transition-transform active:scale-95"
      style={{ width: size, height: size }}
    >
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block", borderRadius: "50%" }} />
      {state !== "idle" && (
        <span
          className="pointer-events-none absolute inset-0 rounded-full border"
          style={{
            borderColor: accent,
            opacity: state === "listening" ? 0.7 : 0.4,
            animation: state === "listening" ? "pulse-soft 1.1s ease-in-out infinite" : undefined,
          }}
        />
      )}
    </button>
  );
}

interface FigureOpts {
  t: number;
  breath: number;
  browRaise: number;
  eyeOpen: number;
  blinkAmount: number;
  gazeX: number;
  gazeY: number;
  smile: number;
  openness: number;
  spread: number;
  speaking: boolean;
}

/** Draw the head, hair, features and shoulders in a 360x360 centred space. */
function drawFigure(ctx: CanvasRenderingContext2D, o: FigureOpts): void {
  const cx = 180;
  const faceCY = 168 + o.breath * 1.1;
  const faceRX = 74;
  const faceRY = 88;

  // ---------------- Shoulders / robe ----------------
  const shoulderTop = faceCY + faceRY + 16;
  ctx.save();
  const robe = ctx.createLinearGradient(0, shoulderTop - 20, 0, 360);
  robe.addColorStop(0, "#20263a");
  robe.addColorStop(0.5, "#141926");
  robe.addColorStop(1, "#080a11");
  ctx.fillStyle = robe;
  ctx.beginPath();
  ctx.moveTo(18, 360);
  ctx.quadraticCurveTo(34, shoulderTop + 6, 108, shoulderTop - 4);
  ctx.quadraticCurveTo(180, shoulderTop + 22, 252, shoulderTop - 4);
  ctx.quadraticCurveTo(326, shoulderTop + 6, 342, 360);
  ctx.closePath();
  ctx.fill();

  // A soft champagne collar, drawn as two crossing lines like a haori.
  const collar = ctx.createLinearGradient(120, shoulderTop, 240, shoulderTop + 70);
  collar.addColorStop(0, "rgba(244,228,188,0.85)");
  collar.addColorStop(1, "rgba(184,154,92,0.5)");
  ctx.strokeStyle = collar;
  ctx.lineWidth = 3.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(132, shoulderTop + 2);
  ctx.quadraticCurveTo(168, shoulderTop + 40, 180, shoulderTop + 74);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(228, shoulderTop + 2);
  ctx.quadraticCurveTo(192, shoulderTop + 40, 180, shoulderTop + 74);
  ctx.stroke();
  ctx.restore();

  // ---------------- Neck ----------------
  ctx.save();
  const neck = ctx.createLinearGradient(cx - 30, 0, cx + 30, 0);
  neck.addColorStop(0, "#c9ab99");
  neck.addColorStop(0.45, "#e2c8b6");
  neck.addColorStop(1, "#bb9c8b");
  ctx.fillStyle = neck;
  ctx.beginPath();
  ctx.moveTo(cx - 26, faceCY + 48);
  ctx.lineTo(cx - 22, faceCY + 96);
  ctx.lineTo(cx + 22, faceCY + 96);
  ctx.lineTo(cx + 26, faceCY + 48);
  ctx.closePath();
  ctx.fill();
  // Shadow under the jaw gives the neck depth.
  const jawShadow = ctx.createLinearGradient(0, faceCY + 46, 0, faceCY + 92);
  jawShadow.addColorStop(0, "rgba(90,60,45,0.55)");
  jawShadow.addColorStop(1, "rgba(90,60,45,0)");
  ctx.fillStyle = jawShadow;
  ctx.fill();
  ctx.restore();

  // ---------------- Ears ----------------
  for (const dir of [-1, 1]) {
    ctx.save();
    const ear = ctx.createRadialGradient(cx + dir * faceRX * 0.97, faceCY + 6, 2, cx + dir * faceRX * 0.97, faceCY + 6, 20);
    ear.addColorStop(0, "#dcc0ae");
    ear.addColorStop(1, "#b3937f");
    ctx.fillStyle = ear;
    ctx.beginPath();
    ctx.ellipse(cx + dir * faceRX * 0.95, faceCY + 6, 11, 19, dir * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---------------- Face ----------------
  // The head is a rounded form, not an ellipse: the jaw tapers and the cheekbones widen.
  const facePath = new Path2D();
  facePath.moveTo(cx, faceCY - faceRY);
  facePath.bezierCurveTo(cx + faceRX * 0.92, faceCY - faceRY * 0.94, cx + faceRX * 1.02, faceCY - 6, cx + faceRX * 0.9, faceCY + 26);
  facePath.bezierCurveTo(cx + faceRX * 0.76, faceCY + 62, cx + 34, faceCY + 92, cx, faceCY + 96);
  facePath.bezierCurveTo(cx - 34, faceCY + 92, cx - faceRX * 0.76, faceCY + 62, cx - faceRX * 0.9, faceCY + 26);
  facePath.bezierCurveTo(cx - faceRX * 1.02, faceCY - 6, cx - faceRX * 0.92, faceCY - faceRY * 0.94, cx, faceCY - faceRY);
  facePath.closePath();

  const skin = ctx.createRadialGradient(cx - 22, faceCY - 26, 10, cx, faceCY + 14, faceRY * 1.5);
  skin.addColorStop(0, "#f3ddcc");
  skin.addColorStop(0.42, "#e8cbb8");
  skin.addColorStop(0.78, "#d4ac97");
  skin.addColorStop(1, "#bb917d");
  ctx.fillStyle = skin;
  ctx.fill(facePath);

  // Cheekbone warmth.
  for (const dir of [-1, 1]) {
    const blush = ctx.createRadialGradient(cx + dir * 42, faceCY + 22, 2, cx + dir * 42, faceCY + 22, 30);
    blush.addColorStop(0, "rgba(219,140,124,0.26)");
    blush.addColorStop(1, "rgba(219,140,124,0)");
    ctx.fillStyle = blush;
    ctx.beginPath();
    ctx.arc(cx + dir * 42, faceCY + 22, 30, 0, Math.PI * 2);
    ctx.fill();
  }

  // Temple shadow, giving the face volume.
  for (const dir of [-1, 1]) {
    const temple = ctx.createLinearGradient(cx + dir * faceRX, faceCY - 20, cx + dir * 24, faceCY + 10);
    temple.addColorStop(0, "rgba(120,84,66,0.30)");
    temple.addColorStop(1, "rgba(120,84,66,0)");
    ctx.fillStyle = temple;
    ctx.beginPath();
    ctx.arc(cx + dir * faceRX * 0.72, faceCY - 8, 40, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rim light from the upper-left, in a cool tone.
  ctx.save();
  ctx.clip(facePath);
  const rim = ctx.createLinearGradient(cx - faceRX, faceCY - faceRY, cx + faceRX * 0.2, faceCY);
  rim.addColorStop(0, "rgba(210,230,255,0.22)");
  rim.addColorStop(1, "rgba(210,230,255,0)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, 360, 360);
  ctx.restore();

  // ---------------- Eyes ----------------
  const eyeY = faceCY - 6;
  const eyeDX = 28;
  const eyeRX = 17;
  const eyeRY = 10.5 * o.eyeOpen;
  const lidClose = o.blinkAmount;

  for (const dir of [-1, 1]) {
    const ex = cx + dir * eyeDX;
    ctx.save();

    // Socket shadow.
    const socket = ctx.createRadialGradient(ex, eyeY - 4, 2, ex, eyeY - 2, 30);
    socket.addColorStop(0, "rgba(120,86,70,0.34)");
    socket.addColorStop(1, "rgba(120,86,70,0)");
    ctx.fillStyle = socket;
    ctx.beginPath();
    ctx.arc(ex, eyeY - 2, 30, 0, Math.PI * 2);
    ctx.fill();

    // Eye opening: an almond, not an ellipse.
    const eyePath = new Path2D();
    eyePath.moveTo(ex - eyeRX, eyeY + 1);
    eyePath.quadraticCurveTo(ex - eyeRX * 0.5, eyeY - eyeRY - 3, ex + eyeRX * 0.15, eyeY - eyeRY);
    eyePath.quadraticCurveTo(ex + eyeRX * 0.72, eyeY - eyeRY * 0.85, ex + eyeRX, eyeY + 1);
    eyePath.quadraticCurveTo(ex + eyeRX * 0.5, eyeY + eyeRY + 3, ex - eyeRX * 0.3, eyeY + eyeRY);
    eyePath.quadraticCurveTo(ex - eyeRX * 0.75, eyeY + eyeRY * 0.9, ex - eyeRX, eyeY + 1);
    eyePath.closePath();

    ctx.save();
    ctx.clip(eyePath);
    const sclera = ctx.createLinearGradient(ex, eyeY - eyeRY, ex, eyeY + eyeRY);
    sclera.addColorStop(0, "#e9e2dc");
    sclera.addColorStop(1, "#cfc4bd");
    ctx.fillStyle = sclera;
    ctx.fillRect(ex - eyeRX - 2, eyeY - eyeRY - 4, eyeRX * 2 + 4, eyeRY * 2 + 8);

    const gx = ex + o.gazeX * 6;
    const gy = eyeY + o.gazeY * 4;
    const irisR = 8.4;
    const iris = ctx.createRadialGradient(gx, gy, 1, gx, gy, irisR);
    iris.addColorStop(0, "#7a5230");
    iris.addColorStop(0.5, "#4f3418");
    iris.addColorStop(1, "#2b1a0c");
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.arc(gx, gy, irisR, 0, Math.PI * 2);
    ctx.fill();
    // Limbal ring: the dark edge that makes an eye read as a real eye.
    ctx.strokeStyle = "rgba(28,16,8,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#0d0906";
    ctx.beginPath();
    ctx.arc(gx, gy, irisR * 0.46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(gx - 2.6, gy - 3.1, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath();
    ctx.arc(gx + 3, gy + 2.6, 1.1, 0, Math.PI * 2);
    ctx.fill();

    // Upper lid shadow across the top of the eye.
    const lidShadow = ctx.createLinearGradient(ex, eyeY - eyeRY, ex, eyeY + 3);
    lidShadow.addColorStop(0, "rgba(70,45,32,0.55)");
    lidShadow.addColorStop(1, "rgba(70,45,32,0)");
    ctx.fillStyle = lidShadow;
    ctx.fillRect(ex - eyeRX - 2, eyeY - eyeRY - 4, eyeRX * 2 + 4, eyeRY + 8);
    ctx.restore();

    // Eyelid: closes downward over the eye.
    if (lidClose > 0.001) {
      ctx.save();
      ctx.clip(eyePath);
      ctx.fillStyle = "#d9b9a6";
      ctx.fillRect(ex - eyeRX - 2, eyeY - eyeRY - 6, eyeRX * 2 + 4, (eyeRY * 2 + 8) * lidClose);
      ctx.restore();
    }

    // Lash line.
    ctx.strokeStyle = "rgba(30,20,14,0.85)";
    ctx.lineWidth = 1.9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ex - eyeRX, eyeY + 0.5);
    ctx.quadraticCurveTo(ex - eyeRX * 0.5, eyeY - eyeRY - 3.4, ex + eyeRX * 0.15, eyeY - eyeRY - 0.4);
    ctx.quadraticCurveTo(ex + eyeRX * 0.72, eyeY - eyeRY * 0.85, ex + eyeRX, eyeY + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- Eyebrows ----------------
  for (const dir of [-1, 1]) {
    const bx = cx + dir * eyeDX;
    const by = eyeY - 21 - o.browRaise * 5;
    ctx.save();
    ctx.strokeStyle = "#3a2a20";
    ctx.lineWidth = 4.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx - dir * 15, by + 2.4 + o.browRaise * 2);
    ctx.quadraticCurveTo(bx, by - 3.2 - o.browRaise * 2, bx + dir * 14, by + 1.4);
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- Nose ----------------
  ctx.save();
  const noseX = cx + 1;
  const noseTop = faceCY - 2;
  const noseTip = faceCY + 26;
  // A shading gradient, not an outline: this is what reads as a nose.
  const noseShade = ctx.createLinearGradient(noseX - 12, noseTop, noseX + 8, noseTip);
  noseShade.addColorStop(0, "rgba(160,118,96,0.10)");
  noseShade.addColorStop(0.6, "rgba(150,105,84,0.30)");
  noseShade.addColorStop(1, "rgba(140,96,76,0.16)");
  ctx.fillStyle = noseShade;
  ctx.beginPath();
  ctx.moveTo(noseX - 5, noseTop + 6);
  ctx.quadraticCurveTo(noseX - 11, noseTip - 6, noseX - 7, noseTip);
  ctx.quadraticCurveTo(noseX, noseTip + 5, noseX + 7, noseTip);
  ctx.quadraticCurveTo(noseX + 11, noseTip - 6, noseX + 5, noseTop + 6);
  ctx.closePath();
  ctx.fill();
  // A soft highlight down the bridge.
  ctx.strokeStyle = "rgba(255,240,230,0.30)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(noseX - 1, noseTop + 10);
  ctx.quadraticCurveTo(noseX - 2, noseTip - 10, noseX - 3, noseTip - 5);
  ctx.stroke();
  // Nostrils.
  ctx.fillStyle = "rgba(90,58,46,0.45)";
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(noseX + dir * 6.4, noseTip - 2, 2.4, 1.5, dir * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // ---------------- Mouth ----------------
  drawMouth(ctx, cx, faceCY + 48, o);

  // ---------------- Hair ----------------
  drawHair(ctx, cx, faceCY, faceRX, faceRY, o.t);
}

function drawMouth(ctx: CanvasRenderingContext2D, cx: number, cy: number, o: FigureOpts): void {
  const halfW = 20 + o.spread * 7;
  const open = o.openness * 13;

  ctx.save();

  // Lips: upper darker, lower fuller and catching light.
  const upper = ctx.createLinearGradient(cx, cy - 6, cx, cy + 1);
  upper.addColorStop(0, "#a86066");
  upper.addColorStop(1, "#8d4a52");
  ctx.fillStyle = upper;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy);
  // Cupid's bow.
  ctx.quadraticCurveTo(cx - halfW * 0.55, cy - 5.2 - o.smile * 1.5, cx - halfW * 0.14, cy - 2.6);
  ctx.quadraticCurveTo(cx, cy - 5.4 - o.smile * 2, cx + halfW * 0.14, cy - 2.6);
  ctx.quadraticCurveTo(cx + halfW * 0.55, cy - 5.2 - o.smile * 1.5, cx + halfW, cy);
  ctx.quadraticCurveTo(cx, cy + 1.4, cx - halfW, cy);
  ctx.closePath();
  ctx.fill();

  const lower = ctx.createLinearGradient(cx, cy + 1, cx, cy + 9);
  lower.addColorStop(0, "#a25a61");
  lower.addColorStop(1, "#7d4149");
  ctx.fillStyle = lower;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy);
  ctx.quadraticCurveTo(cx, cy + 1.4, cx + halfW, cy);
  ctx.quadraticCurveTo(cx + halfW * 0.6, cy + 7 + open * 0.7 + o.smile * 2, cx, cy + 7.4 + open * 0.8 + o.smile * 2);
  ctx.quadraticCurveTo(cx - halfW * 0.6, cy + 7 + open * 0.7 + o.smile * 2, cx - halfW, cy);
  ctx.closePath();
  ctx.fill();

  // The opening, revealed as the jaw drops.
  if (open > 0.6) {
    const cavity = ctx.createLinearGradient(cx, cy, cx, cy + open);
    cavity.addColorStop(0, "#2a1218");
    cavity.addColorStop(1, "#160a0e");
    ctx.fillStyle = cavity;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 1 + open * 0.32, halfW * 0.72, open * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    // Teeth along the upper edge.
    if (open > 4) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy + 1 + open * 0.32, halfW * 0.72, open * 0.52, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#efe8e2";
      ctx.fillRect(cx - halfW, cy - 1, halfW * 2, Math.min(open * 0.34, 4.6));
      ctx.restore();
    }
  }

  // Mouth line.
  ctx.strokeStyle = "rgba(58,28,32,0.55)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy);
  ctx.quadraticCurveTo(cx, cy + 1.2, cx + halfW, cy);
  ctx.stroke();

  // Highlight on the lower lip.
  ctx.strokeStyle = "rgba(255,220,220,0.24)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - halfW * 0.45, cy + 4.6 + open * 0.5);
  ctx.quadraticCurveTo(cx, cy + 6.4 + open * 0.6, cx + halfW * 0.45, cy + 4.6 + open * 0.5);
  ctx.stroke();

  ctx.restore();
}

function drawHair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  faceCY: number,
  faceRX: number,
  faceRY: number,
  t: number,
): void {
  ctx.save();

  const top = faceCY - faceRY;
  const hair = ctx.createLinearGradient(cx - faceRX, top - 14, cx + faceRX, faceCY + 20);
  hair.addColorStop(0, "#2b3247");
  hair.addColorStop(0.45, "#1a1f2e");
  hair.addColorStop(1, "#0b0e16");

  // Main mass: a full crown that sweeps across the brow.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.moveTo(cx - faceRX - 5, faceCY - 8);
  ctx.bezierCurveTo(cx - faceRX - 9, top - 26, cx - 26, top - 34, cx, top - 34);
  ctx.bezierCurveTo(cx + 26, top - 34, cx + faceRX + 9, top - 26, cx + faceRX + 5, faceCY - 8);
  // The fringe: a swept, asymmetric edge across the forehead.
  ctx.bezierCurveTo(cx + faceRX + 2, faceCY - 26, cx + 30, top - 2, cx + 6, top - 4);
  ctx.bezierCurveTo(cx - 12, top - 6, cx - 34, top + 4, cx - faceRX - 2, faceCY - 22);
  ctx.closePath();
  ctx.fill();

  // A single deliberate strand falling across the brow.
  ctx.strokeStyle = "#161b29";
  ctx.lineWidth = 5.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx + 20, top - 14);
  ctx.quadraticCurveTo(cx + 34, faceCY - 34, cx + 26, faceCY - 8);
  ctx.stroke();

  // Sideburns, framing the face.
  for (const dir of [-1, 1]) {
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.moveTo(cx + dir * (faceRX - 2), faceCY - 22);
    ctx.quadraticCurveTo(cx + dir * (faceRX + 5), faceCY + 6, cx + dir * (faceRX - 3), faceCY + 26);
    ctx.quadraticCurveTo(cx + dir * (faceRX - 12), faceCY + 6, cx + dir * (faceRX - 13), faceCY - 22);
    ctx.closePath();
    ctx.fill();
  }

  // Specular sheen: the single highlight that makes hair read as hair.
  const sheen = ctx.createLinearGradient(cx - 30, top - 18, cx + 22, faceCY - 30);
  sheen.addColorStop(0, "rgba(150,175,220,0)");
  sheen.addColorStop(0.5, "rgba(160,185,230,0.16)");
  sheen.addColorStop(1, "rgba(150,175,220,0)");
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.ellipse(cx - 4, top - 12, 34, 12, -0.22, 0, Math.PI * 2);
  ctx.fill();

  // A champagne kanzashi (ornament) — the brand's gold detail.
  ctx.save();
  ctx.translate(cx + faceRX - 4, top - 16);
  ctx.rotate(-0.35 + Math.sin(t * 0.6) * 0.02);
  const gold = ctx.createLinearGradient(-8, -8, 8, 8);
  gold.addColorStop(0, "#f6e7c1");
  gold.addColorStop(1, "#b89a5c");
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(0, 9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -11, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = gold;
  ctx.fill();
  ctx.restore();

  ctx.restore();
}
