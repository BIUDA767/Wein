"use client";

/**
 * Navigation glyphs for the bottom tab bar, drawn as stroked line icons so they stay
 * crisp and inherit the tab's current colour via `currentColor`.
 *
 * The filled variant is used for the selected tab, which is the iOS convention.
 */

export type NavIconKey = "trade" | "positions" | "discover" | "assets" | "more";

interface IconProps {
  size?: number;
  filled?: boolean;
  className?: string;
}

const common = (size: number, className: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  className,
  "aria-hidden": true as const,
});

/** Candlestick chart: three candles with wicks, the middle one rising. */
function TradeIcon({ size = 22, filled, className = "" }: IconProps) {
  return (
    <svg {...common(size, className)}>
      <g fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.6} strokeLinecap="round">
        <rect x="4" y="10" width="3.4" height="7" rx="0.9" />
        <rect x="10.3" y="6.5" width="3.4" height="10" rx="0.9" />
        <rect x="16.6" y="12.5" width="3.4" height="6" rx="0.9" />
      </g>
      {!filled && (
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M5.7 7.6v2.4M5.7 17v2M12 3.6v2.9M12 16.5v3.2M18.3 9.8v2.7M18.3 18.5v2" />
        </g>
      )}
    </svg>
  );
}

/** Wallet with a clasp, for positions. */
function PositionsIcon({ size = 22, filled, className = "" }: IconProps) {
  return (
    <svg {...common(size, className)}>
      <path
        d="M3.4 7.6A2.6 2.6 0 0 1 6 5h10.2a2.6 2.6 0 0 1 2.6 2.6v.5H6a2.6 2.6 0 0 0 0 5.2h12.8v.5A2.6 2.6 0 0 1 16.2 19H6a2.6 2.6 0 0 1-2.6-2.6z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.6}
        strokeLinejoin="round"
      />
      <circle cx="16.4" cy="11" r="1.5" fill={filled ? "#0a0a0b" : "currentColor"} />
    </svg>
  );
}

/** Compass rose, for discover. */
function DiscoverIcon({ size = 22, filled, className = "" }: IconProps) {
  return (
    <svg {...common(size, className)}>
      <circle cx="12" cy="12" r="8.6" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={filled ? 0 : 1.6} />
      <path
        d="M15.6 8.4l-2.05 5.15L8.4 15.6l2.05-5.15z"
        fill={filled ? "#0a0a0b" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth={filled ? 0 : 1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Stacked layers, for the asset universe. */
function AssetsIcon({ size = 22, filled, className = "" }: IconProps) {
  return (
    <svg {...common(size, className)}>
      <path
        d="M12 3.6l8 4.2-8 4.2-8-4.2z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.6}
        strokeLinejoin="round"
      />
      <path
        d="M4 12.4l8 4.2 8-4.2M4 16.6l8 4.2 8-4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth={filled ? 1.9 : 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={filled ? 0.85 : 1}
      />
    </svg>
  );
}

/** Three dots, for the More hub. */
function MoreIcon({ size = 22, filled, className = "" }: IconProps) {
  const r = filled ? 2.2 : 1.9;
  return (
    <svg {...common(size, className)}>
      <circle cx="5.6" cy="12" r={r} fill="currentColor" />
      <circle cx="12" cy="12" r={r} fill="currentColor" />
      <circle cx="18.4" cy="12" r={r} fill="currentColor" />
    </svg>
  );
}

const ICONS: Record<NavIconKey, (p: IconProps) => React.ReactElement> = {
  trade: TradeIcon,
  positions: PositionsIcon,
  discover: DiscoverIcon,
  assets: AssetsIcon,
  more: MoreIcon,
};

export function NavIcon({ name, ...rest }: IconProps & { name: NavIconKey }) {
  const Cmp = ICONS[name];
  return <Cmp {...rest} />;
}
