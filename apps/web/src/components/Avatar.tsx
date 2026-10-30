"use client";

import { useEffect, useRef } from "react";

export type AvatarState = "idle" | "speaking" | "listening" | "thinking" | "alert";

interface AvatarProps {
  state: AvatarState;
  size?: number;
  onClick?: () => void;
  urgency?: "normal" | "attention" | "critical";
}

/**
 * PHIRST2 avatar.
 *
 * A layered SVG figure with a Japanese-inspired aesthetic: porcelain skin, ink-dark
 * hair, champagne and emerald detailing. Animation is driven by the real interaction
 * state (idle breathing, speaking lip-sync, listening pulse, alert glow) rather than a
 * looping decorative video, so the avatar reflects what the system is actually doing.
 */
export function Avatar({ state, size = 72, onClick, urgency = "normal" }: AvatarProps) {
  const mouthRef = useRef<SVGEllipseElement | null>(null);
  const glowRef = useRef<SVGCircleElement | null>(null);

  // Lip-sync: the mouth opens and closes while speech is actually being produced.
  useEffect(() => {
    if (state !== "speaking") {
      if (mouthRef.current) {
        mouthRef.current.setAttribute("ry", "1.6");
        mouthRef.current.setAttribute("rx", "4.2");
      }
      return;
    }
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const openness = 1.6 + Math.abs(Math.sin(frame * 0.9)) * 4.4 + Math.random() * 0.9;
      const width = 4.2 + Math.abs(Math.cos(frame * 0.7)) * 1.3;
      mouthRef.current?.setAttribute("ry", openness.toFixed(2));
      mouthRef.current?.setAttribute("rx", width.toFixed(2));
    }, 72);
    return () => clearInterval(id);
  }, [state]);

  // Listening: the halo pulses in time with the microphone actually being open.
  useEffect(() => {
    if (state !== "listening") {
      glowRef.current?.setAttribute("opacity", "0");
      return;
    }
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const v = 0.28 + Math.abs(Math.sin(frame * 0.35)) * 0.5;
      glowRef.current?.setAttribute("opacity", v.toFixed(2));
    }, 90);
    return () => clearInterval(id);
  }, [state]);

  const accent = urgency === "critical" ? "#ff5c7a" : urgency === "attention" ? "#d4b878" : "#3ddc97";
  const eyeOpen = state === "thinking" ? 0.55 : 1;

  return (
    <button
      onClick={onClick}
      aria-label={`PHIRST2 assistant, ${state}`}
      className={`group relative shrink-0 rounded-full outline-none transition-transform active:scale-95 ${state === "idle" ? "animate-breathe" : ""}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} className="overflow-visible">
        <defs>
          <radialGradient id="ph-halo" cx="50%" cy="45%" r="50%">
            <stop offset="0%" stopColor={accent} stopOpacity="0.55" />
            <stop offset="70%" stopColor={accent} stopOpacity="0.14" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </radialGradient>
          <linearGradient id="ph-skin" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f7e8dd" />
            <stop offset="100%" stopColor="#e6d0c2" />
          </linearGradient>
          <linearGradient id="ph-hair" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#242a3d" />
            <stop offset="100%" stopColor="#0d1017" />
          </linearGradient>
          <linearGradient id="ph-robe" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1b2030" />
            <stop offset="100%" stopColor="#0a0c12" />
          </linearGradient>
          <linearGradient id="ph-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f4e4bc" />
            <stop offset="100%" stopColor="#b89a5c" />
          </linearGradient>
        </defs>

        {/* Halo, used for the listening state and the urgency glow. */}
        <circle ref={glowRef} cx="50" cy="48" r="48" fill="url(#ph-halo)" opacity="0" />
        <circle cx="50" cy="48" r="45" fill="none" stroke={accent} strokeWidth="0.7" opacity={urgency === "normal" ? 0.16 : 0.4} />

        {/* Shoulders and robe. */}
        <path d="M18 96 Q24 68 50 64 Q76 68 82 96 Z" fill="url(#ph-robe)" stroke="rgba(255,255,255,0.07)" strokeWidth="0.6" />
        {/* Champagne collar detail. */}
        <path d="M38 70 Q50 82 62 70" fill="none" stroke="url(#ph-gold)" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M44 66 L50 74 L56 66" fill="none" stroke="url(#ph-gold)" strokeWidth="0.9" opacity="0.75" />

        {/* Neck. */}
        <rect x="44" y="56" width="12" height="11" rx="5" fill="url(#ph-skin)" />

        {/* Head. */}
        <ellipse cx="50" cy="42" rx="19" ry="21" fill="url(#ph-skin)" />
        {/* Jaw shading for depth. */}
        <ellipse cx="50" cy="47" rx="14" ry="15" fill="rgba(0,0,0,0.05)" />

        {/* Hair: an ink-dark Japanese-inspired silhouette with a side sweep. */}
        <path
          d="M29 42 Q27 18 50 16 Q73 18 71 42 Q71 30 63 25 Q50 31 37 25 Q29 30 29 42 Z"
          fill="url(#ph-hair)"
        />
        <path d="M31 36 Q26 46 29 56 Q33 48 33 38 Z" fill="url(#ph-hair)" />
        <path d="M69 36 Q74 46 71 56 Q67 48 67 38 Z" fill="url(#ph-hair)" />
        {/* A single champagne hair ornament. */}
        <circle cx="64" cy="24" r="2.1" fill="url(#ph-gold)" />
        <circle cx="60" cy="22" r="1.2" fill="url(#ph-gold)" opacity="0.8" />

        {/* Brows. */}
        <path d="M39 37 Q43 35 47 37" fill="none" stroke="#3a2b25" strokeWidth="1.1" strokeLinecap="round" opacity="0.8" />
        <path d="M53 37 Q57 35 61 37" fill="none" stroke="#3a2b25" strokeWidth="1.1" strokeLinecap="round" opacity="0.8" />

        {/* Eyes. Closed further when thinking. */}
        <g>
          <ellipse cx="43" cy="42" rx="2.9" ry={3.1 * eyeOpen} fill="#fff" />
          <ellipse cx="57" cy="42" rx="2.9" ry={3.1 * eyeOpen} fill="#fff" />
          <circle cx="43.4" cy="42" r={1.65 * Math.max(eyeOpen, 0.6)} fill="#2b2f3d" />
          <circle cx="57.4" cy="42" r={1.65 * Math.max(eyeOpen, 0.6)} fill="#2b2f3d" />
          <circle cx="42.8" cy="41.3" r="0.55" fill="#fff" opacity="0.9" />
          <circle cx="56.8" cy="41.3" r="0.55" fill="#fff" opacity="0.9" />
        </g>

        {/* Nose. */}
        <path d="M50 44 Q51 46 49.6 47" fill="none" stroke="rgba(90,70,60,0.45)" strokeWidth="0.8" strokeLinecap="round" />

        {/* Mouth: driven by the lip-sync effect above. */}
        <ellipse ref={mouthRef} cx="50" cy="51.5" rx="4.2" ry="1.6" fill="#8c4a4f" />

        {/* Cheek warmth. */}
        <ellipse cx="37" cy="47" rx="3.4" ry="2.1" fill="#e8a5a0" opacity="0.3" />
        <ellipse cx="63" cy="47" rx="3.4" ry="2.1" fill="#e8a5a0" opacity="0.3" />
      </svg>

      {/* State ring: only shown while something is genuinely happening. */}
      {state !== "idle" && (
        <span
          className="pointer-events-none absolute inset-0 rounded-full border-2"
          style={{
            borderColor: accent,
            opacity: state === "listening" ? 0.75 : 0.45,
            animation: state === "listening" ? "pulse-soft 1.1s ease-in-out infinite" : undefined,
          }}
        />
      )}
    </button>
  );
}
