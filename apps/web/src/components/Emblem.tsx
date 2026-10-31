"use client";

import { useId } from "react";

/**
 * The WEIN crystal emblem — a symmetrical, faceted hexagonal crystal built from vector
 * facets. There is no raster asset, so it stays crisp at any size and takes its colour
 * from the metallic palette.
 *
 * The geometry is mirror-symmetric; only the facet shading varies, which is what makes a
 * cut stone read as metal rather than as a flat icon.
 */
export function Emblem({
  size = 32,
  className = "",
  title = "WEIN",
  glow = false,
}: {
  size?: number;
  className?: string;
  title?: string;
  glow?: boolean;
}) {
  // useId() yields characters such as ":" that are invalid inside url(#...).
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = (n: string) => `em-${uid}-${n}`;

  const HEX = "M50 3 L90 28 L90 72 L50 97 L10 72 L10 28 Z";
  const CROWN_L = "M50 3 L10 28 L32 44 L50 32 Z";
  const CROWN_R = "M50 3 L50 32 L68 44 L90 28 Z";
  const MID_L = "M10 28 L10 72 L32 56 L32 44 Z";
  const MID_R = "M90 28 L90 72 L68 56 L68 44 Z";
  const PAV_L = "M10 72 L50 97 L50 68 L32 56 Z";
  const PAV_R = "M50 97 L90 72 L68 56 L50 68 Z";
  const TABLE = "M50 32 L68 44 L68 56 L50 68 L32 56 L32 44 Z";
  const SPEC = "M50 9 L21 28 L28 32 L50 16 Z";
  const EDGES = "M50 3 L50 32 M50 97 L50 68 M10 28 L32 44 M90 28 L68 44 M10 72 L32 56 M90 72 L68 56";

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={id("champ")} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#f8edcc" />
          <stop offset="55%" stopColor="#dcc27c" />
          <stop offset="100%" stopColor="#a6893a" />
        </linearGradient>
        <linearGradient id={id("silver")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eaeef3" />
          <stop offset="50%" stopColor="#b2b9c2" />
          <stop offset="100%" stopColor="#7b828c" />
        </linearGradient>
        <linearGradient id={id("steel")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#98a0aa" />
          <stop offset="100%" stopColor="#4f555c" />
        </linearGradient>
        <linearGradient id={id("table")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="60%" stopColor="#e0e5eb" />
          <stop offset="100%" stopColor="#98a0aa" />
        </linearGradient>
        <linearGradient id={id("spec")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <radialGradient id={id("halo")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="rgba(212,175,55,0.32)" />
          <stop offset="70%" stopColor="rgba(212,175,55,0.08)" />
          <stop offset="100%" stopColor="rgba(212,175,55,0)" />
        </radialGradient>
      </defs>

      {glow && <circle cx="50" cy="50" r="50" fill={`url(#${id("halo")})`} />}

      <path d={HEX} fill={`url(#${id("steel")})`} />
      <path d={CROWN_L} fill={`url(#${id("champ")})`} />
      <path d={CROWN_R} fill={`url(#${id("champ")})`} />
      <path d={MID_L} fill={`url(#${id("silver")})`} />
      <path d={MID_R} fill={`url(#${id("silver")})`} />
      <path d={PAV_L} fill={`url(#${id("steel")})`} />
      <path d={PAV_R} fill={`url(#${id("steel")})`} />
      <path d={TABLE} fill={`url(#${id("table")})`} />
      <path d={SPEC} fill={`url(#${id("spec")})`} />
      <path d={EDGES} fill="none" stroke="rgba(255,255,255,0.38)" strokeWidth="1" strokeLinejoin="round" />
      <path d={HEX} fill="none" stroke="rgba(255,255,255,0.72)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
