/** Formatting helpers for financial figures. */

export function formatUsd(value: number, opts: { compact?: boolean; maximumFractionDigits?: number } = {}) {
  const { compact = false, maximumFractionDigits } = opts;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits:
      maximumFractionDigits ?? (value < 1 ? 4 : value < 1000 ? 2 : compact ? 2 : 0),
  }).format(value);
}

export function formatNumber(value: number, opts: { compact?: boolean } = {}) {
  return new Intl.NumberFormat("en-US", {
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}
