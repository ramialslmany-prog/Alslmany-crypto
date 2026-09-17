/**
 * The simulation engine.
 *
 * This is the piece the whole backtest claim rests on: it drives `runPipeline`
 * — the SAME function the live worker calls, not a simplified copy — bar by
 * bar over history, and executes its output through the SAME monitor and
 * paper broker. Nothing here re-implements a decision. If a rule changes in
 * the pipeline, the backtest changes with it automatically, because there is
 * no second copy of the rule to forget to update.
 *
 * Three properties are enforced structurally rather than by care:
 *
 *  1. POINT IN TIME. The engine never hands the pipeline a candle whose
 *     `closeTime` is after the decision moment. Slicing happens in one
 *     function (`sliceUpTo`), so a look-ahead bug has exactly one place to
 *     live and one place to be tested.
 *
 *  2. NEXT-BAR EXECUTION. Actions decided on bar *i* are applied on bar
 *     *i+1*, at its open, by the broker. The engine holds them in
 *     `pendingActions` between the two steps; it cannot fill on the bar that
 *     produced the signal because that bar is already in the past by then.
 *
 *  3. NO FABRICATED INPUTS. Anything history does not contain (order books,
 *     funding, news) is passed as unavailable, and the pipeline degrades the
 *     way it does live. The engine counts how many runs were affected so the
 *     report can say how optimistic the result is.
 */
import { runPipeline, type RunInput } from "@/core/pipeline/run";
import type { CouncilThresholds } from "@/core/pipeline/stage8-council";
import type { EligibilityThresholds } from "@/core/pipeline/stage1-eligibility";
import type { SetupKind } from "@/core/pipeline/types";
import { returnCorrelation } from "@/core/pipeline/stage2-macro";
import { evaluatePosition, updateExcursions } from "@/core/execution/monitor";
import { applyActions, openPending } from "@/core/execution/paper-broker";
import {
  checkRisk, evaluateBreakers, updateSnapshot, type RiskLimits,
} from "@/core/execution/risk";
import { DEFAULT_COSTS, type CostModel } from "@/core/execution/fills";
import type {
  CircuitBreaker, PortfolioSnapshot, Position, PositionAction,
} from "@/core/execution/types";
import type { Recommendation } from "@/core/recommendation/types";
import { available, unavailable, type Availability } from "@/shared/availability";
import type {
  Candle, FearGreed, FundingRate, LongShortRatio, OpenInterest, SymbolInfo, Ticker24h,
} from "@/core/types";
import type { LiquidationEvent } from "@/core/flows/derivatives";
import { tfMillis, type Timeframe } from "@/shared/time";

const DAY = 86_400_000;

/** Everything the engine knows about one tradable symbol, for all of history. */
export interface BacktestSymbol {
  readonly symbol: string;
  readonly info: SymbolInfo;
  /** First candle that exists anywhere in the archive — the listing proxy. */
  readonly listedAt: number | null;
  readonly candles: Partial<Record<Timeframe, readonly Candle[]>>;
  /**
   * Derivatives history, oldest first, or null when none was imported.
   *
   * Passing it makes stage 5 read the SAME inputs in the backtest that it
   * reads live. Leaving it null is honest but costly: the stage then votes in
   * production and is unavailable in every backtest, so the backtest stops
   * being a test of the strategy that trades.
   */
  readonly derivatives?: {
    readonly openInterest: readonly OpenInterest[];
    readonly longShort: readonly LongShortRatio[];
    readonly funding: readonly FundingRate[];
    readonly liquidations?: readonly LiquidationEvent[];
  } | null;
}

export interface BacktestSettings {
  readonly tradingTimeframe: Timeframe;
  readonly exchange: string;
  readonly hasTakerBreakdown: boolean;
  readonly startingEquity: number;
  readonly riskPercent: number;
  readonly correlationCeiling: number;
  readonly limits: RiskLimits;
  readonly council: CouncilThresholds;
  readonly eligibility: EligibilityThresholds;
  readonly costs: CostModel;
  /**
   * How many bars of each timeframe the pipeline receives.
   *
   * Bounded deliberately: the live worker also holds a window, and a backtest
   * that fed 50,000 bars would be computing indicators from a history the
   * live bot never has.
   */
  readonly lookbackBars: number;
  /** Historical Fear & Greed, oldest first. Empty when not fetched. */
  readonly fearGreedHistory: readonly FearGreed[];
  /**
   * Setups the walk-forward's training window decided to allow.
   *
   * Null means "all of them" — the plain single-window backtest. The
   * walk-forward passes an explicit list so a setup that lost money in the
   * training period is not silently carried into the test period. This is the
   * ONLY thing the training window is allowed to change, and it is applied
   * after the council has already picked a setup, never before: the pipeline
   * is not re-tuned, its output is filtered.
   */
  readonly allowedSetups: readonly SetupKind[] | null;
  /**
   * Setup records carried in from the training window.
   *
   * Without this, the first trades of every test fold run with no history at
   * all, which is not what the live bot would experience.
   */
  readonly seedSetupStats: ReadonlyMap<SetupKind, { trades: number; wins: number; sumR: number }>;
}

export const DEFAULT_LOOKBACK_BARS = 400;

/** One completed trade, in the only unit comparable across symbols: R. */
export interface BacktestTrade {
  readonly symbol: string;
  readonly direction: "long" | "short";
  readonly setup: SetupKind;
  readonly regime: string;
  readonly confidence: number;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly barsHeld: number;
  readonly realizedR: number;
  readonly realizedPnl: number;
  readonly maxFavorableR: number;
  readonly maxAdverseR: number;
  readonly exitReason: string;
  readonly targetsHit: number;
}

export interface EquityPoint {
  readonly at: number;
  readonly equity: number;
  readonly openPositions: number;
  readonly drawdownPct: number;
}

/** Where runs died, so the funnel in the report is measured, not guessed. */
export interface FunnelCounts {
  analyses: number;
  recommendations: number;
  riskBlocked: number;
  /** Discarded because the training window disallowed that setup. */
  setupDisallowed: number;
  /**
   * How often each veto fired, across every run that produced nothing.
   *
   * "Died at the council" is not a diagnosis — the council has ten different
   * ways to say no, and they call for opposite fixes. A run blocked by
   * `no_setup_match` means the setup classifier never recognises anything; one
   * blocked by `score_below_minimum` means the threshold is too high. Without
   * this breakdown the two are indistinguishable, and a silent strategy
   * cannot be told apart from a correctly strict one.
   */
  readonly vetoes: Record<string, number>;
  readonly failedAt: Record<string, number>;
}

export interface BacktestOutcome {
  readonly from: number;
  readonly to: number;
  readonly symbols: readonly string[];
  readonly trades: readonly BacktestTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly funnel: FunnelCounts;
  readonly finalEquity: number;
  readonly breakersTripped: readonly CircuitBreaker[];
  /** Positions still open when the window ended — excluded from the stats. */
  readonly openAtEnd: number;
  readonly caveats: readonly string[];
  /** The setup records as they stood at the end — the next fold's seed. */
  readonly setupStats: ReadonlyMap<SetupKind, { trades: number; wins: number; sumR: number }>;
  /**
   * Final scores of every run that got far enough to name a setup.
   *
   * Without this, "score_below_minimum fired 4,000 times" cannot answer the
   * only question that matters: is the threshold slightly too high, or is it
   * above anything this strategy can ever produce? A distribution answers it
   * in one line; a count never can.
   */
  readonly setupScores: readonly number[];
}

/**
 * The candles a decision at `now` is allowed to see.
 *
 * `closeTime <= now` and nothing else. A bar whose close has not happened is
 * a bar whose high, low and close do not exist yet — feeding one in is the
 * single most common way a backtest becomes a fantasy.
 */
export function sliceUpTo(
  candles: readonly Candle[],
  now: number,
  lookback: number,
): readonly Candle[] {
  // Binary search for the first bar that is NOT yet closed.
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].closeTime <= now) lo = mid + 1;
    else hi = mid;
  }
  return lo <= lookback ? candles.slice(0, lo) : candles.slice(lo - lookback, lo);
}

/**
 * The derivative readings a decision at `now` is allowed to see.
 *
 * Same rule as the candles, and it matters more here: open interest is
 * published every five minutes, so an off-by-one would hand the pipeline a
 * reading from after the decision it is meant to inform.
 */
function upTo<T>(
  rows: readonly T[], now: number, limit: number, at: (row: T) => number,
): readonly T[] {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(rows[mid]) <= now) lo = mid + 1;
    else hi = mid;
  }
  return lo <= limit ? rows.slice(0, lo) : rows.slice(lo - limit, lo);
}

/**
 * A 24-hour ticker rebuilt from candles.
 *
 * Volume, last, high and low are REAL — they come from the archive. Bid and
 * ask are left at zero because no free archive stores them, and the
 * eligibility stage is told (via `requireLiveBook: false`) to skip the two
 * gates that would need them rather than be handed invented numbers.
 */
export function tickerFromCandles(symbol: string, window: readonly Candle[]): Ticker24h | null {
  if (window.length === 0) return null;
  const last = window[window.length - 1];
  const cutoff = last.closeTime - DAY;
  const day = window.filter((c) => c.closeTime > cutoff);
  const first = day[0] ?? last;
  return {
    symbol,
    lastPrice: last.close,
    quoteVolume: day.reduce((s, c) => s + c.quoteVolume, 0),
    priceChangePct: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0,
    highPrice: Math.max(...day.map((c) => c.high)),
    lowPrice: Math.min(...day.map((c) => c.low)),
    bidPrice: 0,
    askPrice: 0,
  };
}

/** The Fear & Greed reading as it stood at `now` — never a later one. */
function fearGreedAt(history: readonly FearGreed[], now: number): Availability<FearGreed> {
  let found: FearGreed | null = null;
  for (const f of history) {
    if (f.timestamp <= now) found = f;
    else break;
  }
  return found === null
    ? unavailable("alternative.me", "insufficient_history", "لا قراءة خوف وطمع عند هذا التاريخ")
    : available(found, "alternative.me", found.timestamp);
}

interface Live {
  position: Position;
  recommendation: Recommendation;
  /** Actions decided on the previous bar, waiting for this bar's open. */
  pending: PositionAction[];
  riskPerUnit: number;
}

/**
 * Run the simulation over one window.
 *
 * `from`/`to` bound the DECISIONS, not the data: candles before `from` are
 * the warm-up the indicators need, and are read but never traded on.
 */
export function runBacktest(
  symbols: readonly BacktestSymbol[],
  settings: BacktestSettings,
  from: number,
  to: number,
): BacktestOutcome {
  const tf = settings.tradingTimeframe;
  const step = tfMillis(tf);
  const btc = symbols.find((s) => s.symbol.startsWith("BTC"));

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const funnel: FunnelCounts = {
    analyses: 0, recommendations: 0, riskBlocked: 0, setupDisallowed: 0,
    failedAt: {}, vetoes: {},
  };
  const breakersTripped: CircuitBreaker[] = [];
  const setupScores: number[] = [];

  const live = new Map<string, Live>();
  let breakers: CircuitBreaker[] = [];
  let realizedEquity = settings.startingEquity;
  let snapshot: PortfolioSnapshot = {
    at: from, equity: settings.startingEquity, cash: settings.startingEquity,
    openPositions: 0, exposureNotional: 0, peakEquity: settings.startingEquity,
    drawdownPct: 0, dayStartEquity: settings.startingEquity, dayPnlPct: 0,
  };
  let dayStamp = Math.floor(from / DAY);

  // Per-setup history, accumulated as the window runs. The council is handed
  // only what it could have known by then — never the window's final numbers.
  const setupStats = new Map<SetupKind, { trades: number; wins: number; sumR: number }>(
    [...settings.seedSetupStats].map(([k, v]) => [k, { ...v }]),
  );

  // The master clock: every trading-timeframe bar close inside the window.
  const closes = new Set<number>();
  for (const s of symbols) {
    for (const c of s.candles[tf] ?? []) {
      if (c.closeTime > from && c.closeTime <= to) closes.add(c.closeTime);
    }
  }
  const timeline = [...closes].sort((a, b) => a - b);

  for (const now of timeline) {
    // ── 1. execute what the previous bar decided, at THIS bar's open ───────
    for (const [symbol, entry] of [...live]) {
      if (entry.pending.length === 0) continue;
      const bar = barAt(symbols, symbol, tf, now);
      if (!bar) continue;

      const result = applyActions(entry.position, entry.pending, {
        candle: bar, orderBook: null, costs: settings.costs, now,
      });
      realizedEquity += result.realizedDelta;
      entry.pending = [];
      entry.position = result.position;

      if (isFinished(result.position)) {
        recordTrade(trades, setupStats, entry);
        live.delete(symbol);
      }
    }

    // ── 2. mark to market and check the breakers ──────────────────────────
    const marks = new Map<string, Candle>();
    for (const [symbol, entry] of live) {
      const bar = barAt(symbols, symbol, tf, now);
      if (!bar) continue;
      marks.set(symbol, bar);
      if (entry.position.status === "open") {
        const ex = updateExcursions(entry.position, bar, entry.riskPerUnit);
        entry.position = {
          ...entry.position, ...ex, barsHeld: entry.position.barsHeld + 1,
        };
      }
    }

    const unrealized = [...live.values()].reduce((s, e) => s + markToMarket(e, marks), 0);
    const equity = realizedEquity + unrealized;

    const stamp = Math.floor(now / DAY);
    const newDay = stamp !== dayStamp;
    if (newDay) dayStamp = stamp;
    snapshot = updateSnapshot(
      snapshot, equity, [...live.values()].map((e) => e.position), now,
      newDay ? equity : undefined,
    );

    const fresh = evaluateBreakers(snapshot, settings.limits, breakers, now);
    if (fresh.length > 0) {
      breakers = [...breakers, ...fresh];
      breakersTripped.push(...fresh);
    }

    equityCurve.push({
      at: now, equity, openPositions: live.size, drawdownPct: snapshot.drawdownPct,
    });

    // ── 3. the monitor decides, on the bar that just closed ───────────────
    for (const [symbol, entry] of [...live]) {
      const bar = marks.get(symbol);
      if (!bar) continue;
      const window = sliceUpTo(
        symbols.find((s) => s.symbol === symbol)?.candles[tf] ?? [], now, settings.lookbackBars,
      );
      entry.pending = evaluatePosition(entry.position, {
        candle: bar,
        barIndex: Math.floor((now - entry.recommendation.generatedAt) / step),
        atr: atrOf(window),
        structureState: "unknown",
        stageScores: {},
        btcDailyScore: null,
        flowsAgainst: false,
        invalidation: entry.recommendation.invalidation,
        now,
      });

      // An expiry or invalidation closes the position inside the monitor's
      // own vocabulary; the broker applies it next bar like anything else.
      if (entry.pending.some((a) => a.kind === "expire" || a.kind === "invalidate")) continue;
    }

    // ── 4. scan for new setups ────────────────────────────────────────────
    if (activeBreakerNow(breakers, now)) continue;

    for (const sym of symbols) {
      const candles = sym.candles[tf] ?? [];
      const bar = candles.find((c) => c.closeTime === now);
      if (!bar) continue; // this symbol has no bar closing here

      const sliced = slicedAll(sym, now, settings.lookbackBars);
      const window = sliced[tf] ?? [];
      if (window.length < 60) continue;

      funnel.analyses += 1;

      const input = buildRunInput(sym, sliced, settings, now, {
        btcDaily: btc ? sliceUpTo(btc.candles["1d"] ?? [], now, settings.lookbackBars) : [],
        btc4h: btc ? sliceUpTo(btc.candles["4h"] ?? [], now, settings.lookbackBars) : [],
        hasActiveRecommendation: live.has(sym.symbol),
        equity,
        portfolio: {
          openPositions: live.size,
          correlatedSameDirection: 0,
          circuitBreakerActive: false,
          circuitBreakerReason: null,
        },
        // The council sees ONLY the record accumulated so far inside this
        // window. Handing it the window's final numbers would be the purest
        // form of look-ahead: the bot grading a setup by how it ends up doing.
        setupHistory: (setup) => {
          const st = setupStats.get(setup);
          return st && st.trades > 0
            ? { trades: st.trades, winRate: st.wins / st.trades, expectancyR: st.sumR / st.trades }
            : null;
        },
      });

      const { run, recommendation } = runPipeline(input);
      if (!recommendation) {
        const where = run.failedAt ?? "none";
        funnel.failedAt[where] = (funnel.failedAt[where] ?? 0) + 1;
        if (run.setup) setupScores.push(run.finalScore);
        for (const veto of run.vetoes) {
          funnel.vetoes[veto.id] = (funnel.vetoes[veto.id] ?? 0) + 1;
        }
        continue;
      }

      // The council already applied its own portfolio vetoes; the risk layer
      // is the independent second check, exactly as it is live.
      const correlations: Record<string, number> = {};
      for (const [other] of live) {
        const a = sliceUpTo(sym.candles["1d"] ?? [], now, settings.lookbackBars);
        const b = sliceUpTo(
          symbols.find((s) => s.symbol === other)?.candles["1d"] ?? [], now, settings.lookbackBars,
        );
        correlations[other] = returnCorrelation(a, b) ?? 0;
      }

      const decision = checkRisk({
        snapshot,
        openPositions: [...live.values()].map((e) => e.position),
        candidate: { symbol: sym.symbol, direction: recommendation.direction },
        correlations,
        activeBreakers: breakers,
        limits: settings.limits,
        now,
      });

      if (!decision.allowed) {
        funnel.riskBlocked += 1;
        continue;
      }

      if (settings.allowedSetups && !settings.allowedSetups.includes(recommendation.setup)) {
        funnel.setupDisallowed += 1;
        continue;
      }

      funnel.recommendations += 1;
      const riskPerUnit = Math.abs(recommendation.entry.mid - recommendation.stop);
      live.set(sym.symbol, {
        recommendation,
        riskPerUnit,
        pending: [],
        position: openPending({
          id: `bt-${recommendation.id}`,
          recommendationId: recommendation.id,
          symbol: sym.symbol,
          direction: recommendation.direction,
          timeframe: tf,
          entry: recommendation.entry,
          stop: recommendation.stop,
          targets: recommendation.targets.map((t) => ({
            index: t.index, price: t.price, closeFraction: t.closeFraction,
          })),
          size: recommendation.positionSize,
          risk: recommendation.riskAmount,
          expiresAt: recommendation.expiresAt,
        }),
      });
    }
  }

  const caveats = [
    "Spread and depth were NOT checked: no free archive stores historical order books. The result is optimistic by exactly those two gates.",
    "On-chain (stage 6) and news are not available historically, so they passed as \"unavailable\" with a declared confidence penalty — exactly as they do live when the provider is missing.",
    "Slippage is modelled from candle liquidity, not from a real book.",
    settings.fearGreedHistory.length === 0
      ? "No Fear & Greed history was supplied, so the sentiment stage ran without it."
      : `Fear & Greed history supplied (${settings.fearGreedHistory.length} readings).`,
  ];

  return {
    from, to,
    symbols: symbols.map((s) => s.symbol),
    trades,
    equityCurve,
    funnel,
    finalEquity: equityCurve.length ? equityCurve[equityCurve.length - 1].equity : settings.startingEquity,
    breakersTripped,
    openAtEnd: live.size,
    caveats,
    setupStats,
    setupScores,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function barAt(
  symbols: readonly BacktestSymbol[], symbol: string, tf: Timeframe, closeTime: number,
): Candle | null {
  const candles = symbols.find((s) => s.symbol === symbol)?.candles[tf] ?? [];
  return candles.find((c) => c.closeTime === closeTime) ?? null;
}

function slicedAll(
  sym: BacktestSymbol, now: number, lookback: number,
): Partial<Record<Timeframe, readonly Candle[]>> {
  const out: Partial<Record<Timeframe, readonly Candle[]>> = {};
  for (const [tf, candles] of Object.entries(sym.candles) as [Timeframe, readonly Candle[]][]) {
    out[tf] = sliceUpTo(candles, now, lookback);
  }
  return out;
}

function isFinished(p: Position): boolean {
  return p.status === "closed" || p.status === "expired" || p.status === "invalidated";
}

function markToMarket(entry: Live, marks: Map<string, Candle>): number {
  const p = entry.position;
  if (p.status !== "open" || p.openQuantity <= 0) return p.realizedPnl;
  const bar = marks.get(p.symbol);
  if (!bar) return p.realizedPnl;
  const move = p.direction === "long" ? bar.close - p.averageEntry : p.averageEntry - bar.close;
  return p.realizedPnl + move * p.openQuantity;
}

function recordTrade(
  trades: BacktestTrade[],
  stats: Map<SetupKind, { trades: number; wins: number; sumR: number }>,
  entry: Live,
): void {
  const p = entry.position;
  // A position that expired without ever filling is not a trade — counting it
  // as a zero-R result would dilute every statistic with non-events.
  if (p.openedAt === null) return;

  const realizedR = entry.riskPerUnit > 0 && p.plannedSize > 0
    ? p.realizedPnl / (entry.riskPerUnit * p.plannedSize)
    : 0;

  trades.push({
    symbol: p.symbol,
    direction: p.direction,
    setup: entry.recommendation.setup,
    regime: entry.recommendation.regime,
    confidence: entry.recommendation.confidence,
    openedAt: p.openedAt,
    closedAt: p.closedAt ?? p.openedAt,
    barsHeld: p.barsHeld,
    realizedR,
    realizedPnl: p.realizedPnl,
    maxFavorableR: p.maxFavorableR,
    maxAdverseR: p.maxAdverseR,
    exitReason: p.exitReason ?? "unknown",
    targetsHit: p.targetsHit.length,
  });

  const s = stats.get(entry.recommendation.setup) ?? { trades: 0, wins: 0, sumR: 0 };
  stats.set(entry.recommendation.setup, {
    trades: s.trades + 1,
    wins: s.wins + (realizedR > 0 ? 1 : 0),
    sumR: s.sumR + realizedR,
  });
}

function activeBreakerNow(breakers: readonly CircuitBreaker[], now: number): boolean {
  return breakers.some((b) => b.requiresManualReset || b.resumesAt === null || now < b.resumesAt);
}

/** Wilder ATR over the sliced window — the same 14 the live path uses. */
function atrOf(window: readonly Candle[], period = 14): number {
  if (window.length < period + 1) return 0;
  let atr = 0;
  for (let i = window.length - period; i < window.length; i++) {
    const prev = window[i - 1];
    const c = window[i];
    atr += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return atr / period;
}

function buildRunInput(
  sym: BacktestSymbol,
  candles: Partial<Record<Timeframe, readonly Candle[]>>,
  settings: BacktestSettings,
  now: number,
  x: {
    btcDaily: readonly Candle[];
    btc4h: readonly Candle[];
    hasActiveRecommendation: boolean;
    equity: number;
    portfolio: RunInput["portfolio"];
    setupHistory: RunInput["setupHistory"];
  },
): RunInput {
  const window = candles[settings.tradingTimeframe] ?? [];

  // Derivatives, sliced point-in-time exactly like the candles.
  const d = sym.derivatives ?? null;
  const openInterest = d ? upTo(d.openInterest, now, 48, (r) => r.timestamp) : [];
  const longShort = d ? upTo(d.longShort, now, 48, (r) => r.timestamp) : [];
  // Funding is timestamped by SETTLEMENT, not by publication.
  const fundingHistory = d ? upTo(d.funding, now, 100, (r) => r.fundingTime) : [];
  const fundingNow = fundingHistory.length > 0 ? fundingHistory[fundingHistory.length - 1] : null;

  // Liquidations from the last week only: a cluster from two months ago has
  // been traded through many times and is no longer where the leverage is.
  const liquidationEvents = d?.liquidations
    ? upTo(d.liquidations, now, 50_000, (r) => r.timestamp).filter((r) => r.timestamp >= now - 7 * DAY)
    : null;

  return {
    symbol: sym.symbol,
    tradingTimeframe: settings.tradingTimeframe,
    exchange: settings.exchange,
    candles,
    hasTakerBreakdown: settings.hasTakerBreakdown,
    eligibility: {
      symbol: sym.symbol,
      info: sym.info,
      ticker: tickerFromCandles(sym.symbol, window),
      orderBook: null, // honestly absent — the gates are skipped, not faked
      listedAt: sym.listedAt,
      upcomingUnlock: null,
      hasActiveRecommendation: x.hasActiveRecommendation,
      now,
    },
    eligibilityThresholds: settings.eligibility,
    macro: {
      btcDaily: x.btcDaily,
      btc4h: x.btc4h,
      global: unavailable("coingecko", "insufficient_history", "لا تاريخ لهيمنة السوق في الأرشيف"),
      dominanceHistory: unavailable("coingecko", "insufficient_history", "لا تاريخ للهيمنة"),
      fearGreed: fearGreedAt(settings.fearGreedHistory, now),
    },
    correlationCeiling: settings.correlationCeiling,
    // Stage 5 runs on what history genuinely holds: the taker-buy split gives
    // a real CVD. Books, funding and open interest are not archived, so they
    // arrive null and the stage reports which parts it could not read.
    flowsInput: {
      trades: null,
      bookSnapshots: null,
      funding: fundingNow,
      fundingHistory: fundingHistory.length > 0 ? fundingHistory : null,
      openInterest: openInterest.length > 0 ? openInterest : null,
      longShort: longShort.length > 0 ? longShort : null,
      liquidationEvents: liquidationEvents && liquidationEvents.length > 0 ? liquidationEvents : null,
      atr: atrOf(window),
    },
    sentimentInput: {
      fearGreed: fearGreedAt(settings.fearGreedHistory, now),
      fearGreedHistory: settings.fearGreedHistory.length
        ? available(
            settings.fearGreedHistory.filter((f) => f.timestamp <= now),
            "alternative.me",
            now,
          )
        : unavailable("alternative.me", "insufficient_history", "لا تاريخ للخوف والطمع"),
      news: unavailable("rss", "insufficient_history", "لا أرشيف أخبار تاريخي — لم تُختلق أخبار"),
      calendar: null,
      social: unavailable("lunarcrush", "not_configured", "لا مزوّد اجتماعي"),
    },
    council: settings.council,
    portfolio: x.portfolio,
    setupHistory: x.setupHistory,
    equity: x.equity,
    riskPercent: settings.riskPercent,
    pricePrecision: sym.info.pricePrecision,
    quantityPrecision: sym.info.quantityPrecision,
    minNotional: sym.info.minNotional,
    now,
  };
}

export const __testing = { sliceUpTo, tickerFromCandles, atrOf, fearGreedAt };
