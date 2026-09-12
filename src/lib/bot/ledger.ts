import type { ExitReason, LedgerStats, Position } from "./types";

/**
 * Trade statistics.
 *
 * This is what the public track record reads from, so it is computed from the
 * closed-position ledger and nothing else — there is no path here that can
 * select which trades to count. Losses are reported with the same prominence
 * as wins, and every figure is derived, never stored, so a stat cannot drift
 * away from the trades that produced it.
 */

const EMPTY_REASONS: Record<ExitReason, number> = {
  target: 0, stop: 0, breakeven: 0, trailing: 0, time: 0, regime: 0, manual: 0,
  thesis: 0, weakened: 0,
};

export function computeStats(closed: Position[]): LedgerStats {
  const trades = closed.length;
  if (trades === 0) {
    return {
      trades: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0,
      expectancyR: 0, totalR: 0, averageWinR: 0, averageLossR: 0,
      profitFactor: null, maxDrawdownR: 0, longestWinStreak: 0,
      longestLossStreak: 0, averageHoldHours: 0, bestR: 0, worstR: 0,
      byReason: { ...EMPTY_REASONS },
    };
  }

  const ordered = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const rs = ordered.map((p) => p.realizedR);

  // A trade within a rounding error of flat is neither a win nor a loss.
  // Counting scratches as wins is the easiest way to publish a flattering
  // win rate that means nothing.
  const EPS = 0.02;
  const wins = rs.filter((r) => r > EPS).length;
  const losses = rs.filter((r) => r < -EPS).length;
  const breakeven = trades - wins - losses;

  const grossWin = rs.filter((r) => r > EPS).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < -EPS).reduce((s, r) => s + r, 0));
  const totalR = rs.reduce((s, r) => s + r, 0);

  // Peak-to-trough of the cumulative R curve.
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of rs) {
    cumulative += r;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  let winStreak = 0;
  let lossStreak = 0;
  let longestWin = 0;
  let longestLoss = 0;
  for (const r of rs) {
    if (r > EPS) {
      winStreak++; lossStreak = 0;
      longestWin = Math.max(longestWin, winStreak);
    } else if (r < -EPS) {
      lossStreak++; winStreak = 0;
      longestLoss = Math.max(longestLoss, lossStreak);
    } else {
      winStreak = 0; lossStreak = 0;
    }
  }

  const holdHours = ordered
    .filter((p) => p.closedAt)
    .map((p) => ((p.closedAt as number) - p.openedAt) / 3_600_000);

  const byReason = { ...EMPTY_REASONS };
  for (const p of ordered) if (p.exitReason) byReason[p.exitReason]++;

  const round = (n: number) => Number(n.toFixed(3));

  return {
    trades,
    wins,
    losses,
    breakeven,
    winRate: round((wins / trades) * 100),
    // Expectancy is the number that decides whether an edge exists at all.
    // A 40% win rate at +2R beats a 70% win rate at +0.3R, and only this
    // figure shows that.
    expectancyR: round(totalR / trades),
    totalR: round(totalR),
    averageWinR: wins > 0 ? round(grossWin / wins) : 0,
    averageLossR: losses > 0 ? round(-grossLoss / losses) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdownR: round(maxDrawdown),
    longestWinStreak: longestWin,
    longestLossStreak: longestLoss,
    averageHoldHours: holdHours.length
      ? round(holdHours.reduce((s, h) => s + h, 0) / holdHours.length)
      : 0,
    bestR: round(Math.max(...rs)),
    worstR: round(Math.min(...rs)),
    byReason,
  };
}

/** Cumulative R curve, one point per closed trade. */
export function equityCurve(closed: Position[]): { at: number; cumulative: number }[] {
  const ordered = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let cumulative = 0;
  return ordered.map((p) => {
    cumulative = Number((cumulative + p.realizedR).toFixed(4));
    return { at: p.closedAt ?? p.openedAt, cumulative };
  });
}

/** Break results down by a facet, so a single lucky sector cannot hide. */
export function groupStats<K extends string>(
  closed: Position[],
  key: (p: Position) => K,
): Record<K, LedgerStats> {
  const groups = new Map<K, Position[]>();
  for (const p of closed) {
    const k = key(p);
    const list = groups.get(k) ?? [];
    list.push(p);
    groups.set(k, list);
  }
  const out = {} as Record<K, LedgerStats>;
  for (const [k, list] of groups) out[k] = computeStats(list);
  return out;
}
