import type { Candle, Series, Timeframe } from "@/lib/market/types";
import type { UniverseEntry } from "@/lib/market/universe";
import { atr, last } from "@/lib/analysis/indicators";
import { classifyMarket } from "@/lib/analysis/regime";
import { recommend } from "@/lib/engine/recommendation";
import { PaperBroker, type Broker } from "./broker";
import { canOpen, openPosition, stepPosition, type Quote } from "./engine";
import { computeStats, equityCurve } from "./ledger";
import {
  DEFAULT_BOT_CONFIG, emptyState, type BotConfig, type LedgerStats, type Position,
} from "./types";

/**
 * Walk-forward backtest.
 *
 * Runs the *same* engine the live bot runs — not a simplified copy of it. A
 * backtest of a different strategy than the one you deploy tells you nothing,
 * and keeping two implementations in step is a promise nobody keeps.
 *
 * Two rules make the result honest:
 *
 *  1. **No look-ahead.** A decision is taken on the close of bar i using only
 *     bars 0…i, and is executed at the open of bar i+1. Filling at the close
 *     of the bar you decided on means trading on a price you could not have
 *     known, and it is the most common reason a backtest cannot be reproduced.
 *  2. **Pessimistic intrabar ordering.** When a bar's range covers both the
 *     stop and a target, the stop is taken first (enforced in stepPosition).
 *
 * Slippage is charged against us on entry and exit by the paper broker.
 */

/** Aggregate `factor` consecutive bars into one higher-timeframe bar. */
export function resample(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    out.push({
      t: group[0].t,
      o: group[0].o,
      h: Math.max(...group.map((c) => c.h)),
      l: Math.min(...group.map((c) => c.l)),
      c: group[group.length - 1].c,
      v: group.reduce((s, c) => s + c.v, 0),
    });
  }
  return out;
}

/** How many base bars make up each higher timeframe. */
const RESAMPLE_FACTORS: Record<Timeframe, Partial<Record<Timeframe, number>>> = {
  "15m": { "15m": 1, "1h": 4, "4h": 16, "1d": 96 },
  "1h": { "1h": 1, "4h": 4, "1d": 24 },
  "4h": { "4h": 1, "1d": 6 },
  "1d": { "1d": 1 },
};

export type BacktestResult = {
  symbol: string;
  timeframe: Timeframe;
  /** Bars actually traded, after the indicator warm-up. */
  barsTested: number;
  /** Bars that reached the engine, rather than being skipped for want of data. */
  barsEvaluated: number;
  /** Bars that produced an actual recommendation. */
  barsAnalysed: number;
  from: number;
  to: number;
  trades: Position[];
  stats: LedgerStats;
  equityR: { at: number; cumulative: number }[];
  /**
   * True when no Bitcoin series was supplied and the asset's own higher
   * timeframe stood in for the market regime. Stated rather than hidden,
   * because it makes the regime gate weaker than it is in production.
   */
  marketProxy: boolean;
  /** Buy-and-hold over the same window, as the benchmark to beat. */
  buyHoldPct: number;
  config: BotConfig;
};

/**
 * Analysis only ever looks at the trailing window, which keeps the run linear
 * rather than quadratic in series length.
 *
 * The window has to be wide enough to survive resampling: sixty 1d bars need
 * 1440 hourly bars behind them. Too narrow a window silently starves the
 * higher timeframes, and a starved higher timeframe means the regime gate
 * never runs at all.
 */
const MAX_WINDOW = 1200;
const WARMUP = 260;
/** A resampled timeframe is only usable with at least this many bars. */
const MIN_TF_BARS = 60;

export async function backtest(input: {
  entry: UniverseEntry;
  candles: Candle[];
  timeframe: Timeframe;
  /** Bitcoin bars on the same timeframe, for a real market regime. */
  btcCandles?: Candle[] | null;
  config?: Partial<BotConfig>;
  broker?: Broker;
  /** Re-evaluate entries every N bars. 1 is every bar. */
  stride?: number;
}): Promise<BacktestResult> {
  const config: BotConfig = { ...DEFAULT_BOT_CONFIG, ...input.config };
  const broker = input.broker ?? new PaperBroker();
  const stride = Math.max(1, input.stride ?? 1);
  const { candles, timeframe, entry } = input;

  if (candles.length < WARMUP + 20) {
    throw new Error(`need at least ${WARMUP + 20} bars to backtest, got ${candles.length}`);
  }

  const factors = RESAMPLE_FACTORS[timeframe];
  const marketProxy = !input.btcCandles || input.btcCandles.length < WARMUP;

  let state = emptyState(candles[WARMUP].t);
  const closedTrades: Position[] = [];
  /** How many bars actually reached the engine, as opposed to being skipped. */
  let evaluated = 0;
  /** How many of those produced a real recommendation. */
  let analysed = 0;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const bar = candles[i];
    const nextBar = candles[i + 1];

    // ── Manage what is already open, using this bar's range ──
    const window = candles.slice(Math.max(0, i + 1 - MAX_WINDOW), i + 1);
    const atrNow = last(atr(window, 14)) ?? bar.c * 0.02;
    const quote: Quote = { symbol: entry.symbol, bar, atr: atrNow };

    const stillOpen: Position[] = [];
    for (const position of state.positions) {
      const result = await stepPosition(position, quote, config, broker);
      if (result.position.status === "closed") closedTrades.push(result.position);
      else stillOpen.push(result.position);
    }
    state = { ...state, positions: stillOpen };

    // ── Consider a new entry, decided on closed data only ──
    if (state.positions.length > 0 || (i - WARMUP) % stride !== 0) continue;

    // Only include a timeframe the available history can actually support.
    // Emitting a 12-bar "daily" would let indicators return nulls that read
    // downstream as an absence of evidence rather than an absence of data.
    const stack: Partial<Record<Timeframe, Series | null>> = {};
    let leaderFactor = 1;
    for (const [tf, factor] of Object.entries(factors) as [Timeframe, number][]) {
      const resampled = factor === 1 ? window : resample(window, factor);
      if (resampled.length < MIN_TF_BARS) continue;
      stack[tf] = {
        symbol: entry.symbol,
        timeframe: tf,
        candles: resampled,
        source: "binance",
        fetchedAt: bar.t,
      };
      leaderFactor = Math.max(leaderFactor, factor);
    }

    // The regime leader is the highest timeframe the history supports —
    // Bitcoin's when supplied, the asset's own otherwise.
    const btcWindow = marketProxy
      ? null
      : input.btcCandles!.slice(Math.max(0, i + 1 - MAX_WINDOW), i + 1);
    const leaderBars = btcWindow
      ? resample(btcWindow, leaderFactor)
      : resample(window, leaderFactor);

    if (leaderBars.length < MIN_TF_BARS) continue;
    evaluated++;

    const market = classifyMarket({ btcCandles: leaderBars, breadth: null, fearGreed: null });
    const rec = recommend({ entry, stack, market });
    if (!rec) continue;
    analysed++;

    const gate = canOpen(state, rec, config);
    if (!gate.ok) continue;

    // Execute at the NEXT bar's open — the first price actually available
    // after the decision was made.
    const opened = await openPosition(
      { ...rec, price: nextBar.o },
      config,
      broker,
      nextBar.t,
    );
    if (opened) {
      state = { ...state, positions: [...state.positions, opened.position] };
    }
  }

  // Close anything still open at the final price, so nothing hides in limbo.
  const finalBar = candles[candles.length - 1];
  for (const position of state.positions) {
    const fill = await broker.sell(position, finalBar.c, position.remaining, "manual", finalBar.t);
    const exits = [...position.fills, fill].filter((f) => f.reason !== "entry");
    closedTrades.push({
      ...position,
      fills: [...position.fills, fill],
      remaining: 0,
      status: "closed",
      closedAt: finalBar.t,
      exitReason: "manual",
      realizedR: Number(exits.reduce((s, f) => s + f.fraction * f.rMultiple, 0).toFixed(4)),
      realizedPct: Number(
        exits
          .reduce((s, f) => s + f.fraction * ((f.price - position.entry) / position.entry) * 100, 0)
          .toFixed(4),
      ),
    });
  }

  // A run that produced no analysis at all is not a run with no signals — it
  // is a broken run, and reporting "0 trades" for it would read as a finding.
  // This happens when the history is long enough to iterate but too short to
  // resample into the higher timeframe the engine requires before it will
  // call anything.
  if (evaluated === 0 || analysed === 0) {
    throw new Error(
      `backtest produced no analysis: ${candles.length} ${timeframe} bars cannot be ` +
        `resampled into a higher timeframe of at least ${MIN_TF_BARS} bars. ` +
        `Supply more history, or backtest on a higher base timeframe.`,
    );
  }

  const first = candles[WARMUP];
  return {
    symbol: entry.symbol,
    timeframe,
    barsTested: candles.length - WARMUP - 1,
    barsEvaluated: evaluated,
    barsAnalysed: analysed,
    from: first.t,
    to: finalBar.t,
    trades: closedTrades,
    stats: computeStats(closedTrades),
    equityR: equityCurve(closedTrades),
    marketProxy,
    buyHoldPct: Number((((finalBar.c - first.c) / first.c) * 100).toFixed(2)),
    config,
  };
}
