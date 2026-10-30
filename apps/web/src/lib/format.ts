export function money(v: number | string | null | undefined, digits = 2): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${money(v)}`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function statusTone(state: string): "good" | "bad" | "warn" | "neutral" {
  if (state === "running") return "good";
  if (state === "emergency") return "bad";
  if (state === "paused" || state === "halted") return "warn";
  return "neutral";
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
