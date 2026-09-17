/**
 * Backtest metrics.
 *
 * Every number here is computed the way that makes the strategy look WORSE
 * when the two conventions differ, because a backtest's only job is to be
 * disbelievable. Specifically:
 *
 *  - Expectancy is per trade in R, not total R, so a strategy cannot look
 *    good by simply trading more.
 *  - The profit factor counts fees and slippage, because they are already
 *    inside `realizedPnl`.
 *  - Max drawdown is measured on the EQUITY CURVE including open positions,
 *    not on closed trades only — the latter hides every drawdown the bot
 *    actually sat through.
 *  - Buy-and-hold is compared over the identical window, with the identical
 *    starting capital, and it is reported even when it wins. Rule #5.
 */
import type { BacktestOutcome, BacktestTrade, EquityPoint } from "@/core/backtest/engine";
import type { SetupKind } from "@/core/pipeline/types";
import type { Candle } from "@/core/types";

export interface Metrics {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  /** Mean R per trade — the headline number. */
  readonly expectancyR: number;
  readonly totalR: number;
  readonly averageWinR: number;
  readonly averageLossR: number;
  readonly profitFactor: number | null;
  readonly netPnl: number;
  readonly returnPct: number;
  readonly maxDrawdownPct: number;
  readonly longestLosingStreak: number;
  readonly averageBarsHeld: number;
  /** Mean adverse excursion of WINNERS — how much heat a win took. */
  readonly averageHeatR: number;
}

export function computeMetrics(
  trades: readonly BacktestTrade[],
  equityCurve: readonly EquityPoint[],
  startingEquity: number,
): Metrics {
  const wins = trades.filter((t) => t.realizedR > 0);
  const losses = trades.filter((t) => t.realizedR <= 0);
  const totalR = trades.reduce((s, t) => s + t.realizedR, 0);
  const grossWin = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedPnl, 0));
  const netPnl = trades.reduce((s, t) => s + t.realizedPnl, 0);

  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    streak = t.realizedR <= 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  let peak = startingEquity;
  let maxDd = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - point.equity) / peak) * 100);
  }

  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancyR: trades.length ? totalR / trades.length : 0,
    totalR,
    averageWinR: mean(wins.map((t) => t.realizedR)),
    averageLossR: mean(losses.map((t) => t.realizedR)),
    // Null, not Infinity: "no losing trades yet" is a sample-size statement,
    // and printing ∞ invites reading it as a quality statement.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    netPnl,
    returnPct: startingEquity > 0 ? (netPnl / startingEquity) * 100 : 0,
    maxDrawdownPct: maxDd,
    longestLosingStreak: longest,
    averageBarsHeld: mean(trades.map((t) => t.barsHeld)),
    averageHeatR: mean(wins.map((t) => t.maxAdverseR)),
  };
}

export interface SetupBreakdown {
  readonly setup: SetupKind;
  readonly metrics: Metrics;
}

/**
 * Per-setup results.
 *
 * The spec asks for this because an aggregate can hide a setup that loses
 * steadily behind one that wins big. A setup with fewer than ~20 trades is
 * reported with its count so the reader can discount it themselves rather
 * than being shown a 70% win rate from seven trades as if it meant anything.
 */
export function bySetup(
  trades: readonly BacktestTrade[],
  startingEquity: number,
): SetupBreakdown[] {
  const groups = new Map<SetupKind, BacktestTrade[]>();
  for (const t of trades) {
    const list = groups.get(t.setup) ?? [];
    list.push(t);
    groups.set(t.setup, list);
  }
  return [...groups].map(([setup, list]) => ({
    setup,
    // No equity curve per setup — drawdown is a portfolio property, and a
    // per-setup "drawdown" would be a number with no real-world meaning.
    metrics: computeMetrics(list, [], startingEquity),
  })).sort((a, b) => b.metrics.trades - a.metrics.trades);
}

export interface BuyAndHold {
  readonly symbol: string;
  readonly returnPct: number;
  readonly maxDrawdownPct: number;
}

/**
 * The benchmark the strategy has to beat to be worth running.
 *
 * Measured on the same window and with the same entry fee the bot pays, so
 * the comparison is not quietly flattered by giving the benchmark a free
 * entry.
 */
export function buyAndHold(
  symbol: string,
  candles: readonly Candle[],
  from: number,
  to: number,
  feeBps: number,
): BuyAndHold | null {
  const window = candles.filter((c) => c.closeTime > from && c.closeTime <= to);
  if (window.length < 2) return null;

  const entry = window[0].open * (1 + feeBps / 10_000);
  const exit = window[window.length - 1].close * (1 - feeBps / 10_000);

  let peak = entry;
  let maxDd = 0;
  for (const c of window) {
    peak = Math.max(peak, c.high);
    maxDd = Math.max(maxDd, ((peak - c.low) / peak) * 100);
  }

  return {
    symbol,
    returnPct: ((exit - entry) / entry) * 100,
    maxDrawdownPct: maxDd,
  };
}

/**
 * The funnel ratio the spec calls out: one recommendation per 20–100 analyses.
 *
 * Returned as a verdict rather than a number alone, because the whole point
 * of the figure is the judgement attached to it: far more than one in twenty
 * means the filters are not filtering.
 */
export function funnelVerdict(outcome: BacktestOutcome): {
  ratio: number | null;
  verdict: "too_loose" | "healthy" | "too_tight" | "no_data";
  arabic: string;
} {
  const { analyses, recommendations } = outcome.funnel;
  if (analyses === 0) return { ratio: null, verdict: "no_data", arabic: "لا تحليلات في هذه النافذة." };
  if (recommendations === 0) {
    return {
      ratio: null,
      verdict: "too_tight",
      arabic: `${analyses} تحليلاً دون توصية واحدة. الفلاتر أضيق من أن تُنتج شيئاً في هذه النافذة.`,
    };
  }
  const ratio = analyses / recommendations;
  const verdict = ratio < 20 ? "too_loose" : ratio > 100 ? "too_tight" : "healthy";
  const arabic =
    verdict === "too_loose"
      ? `توصية واحدة لكل ${ratio.toFixed(0)} تحليلاً — أقل من 20. الفلاتر ضعيفة والبوت يوافق أكثر مما ينبغي.`
      : verdict === "too_tight"
        ? `توصية واحدة لكل ${ratio.toFixed(0)} تحليلاً — أكثر من 100. الفلاتر ضيقة إلى حدّ قد يُفوّت فرصاً حقيقية.`
        : `توصية واحدة لكل ${ratio.toFixed(0)} تحليلاً — ضمن النطاق المنطقي (20 إلى 100).`;
  return { ratio, verdict, arabic };
}
