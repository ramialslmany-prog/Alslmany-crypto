/**
 * Walk-forward evaluation.
 *
 * Six months of training, one month of testing, rolled forward. The training
 * window is NOT used to fit parameters — this strategy has none to fit — so
 * it would be dishonest to call this "optimization". What the training window
 * actually decides is narrower and stated plainly:
 *
 *   1. which setups are allowed into the test month (those that at least
 *      broke even on a usable sample), and
 *   2. the setup records the council starts the test month with.
 *
 * Everything else — every threshold, weight and veto — is identical in both
 * windows. That matters: a walk-forward over a strategy with no fitted
 * parameters mostly measures STABILITY, and stability is exactly what a
 * reader needs to know before trusting a single-window result.
 *
 * The last 20% of the period is held out and never touched by the rolling
 * loop. `runHoldout` is a separate call, meant to be made ONCE, at the end,
 * after every decision has already been made. The worker records each use on
 * disk so a second run cannot happen by accident.
 */
import {
  runBacktest, type BacktestOutcome, type BacktestSettings, type BacktestSymbol,
} from "@/core/backtest/engine";
import { bySetup, computeMetrics, type Metrics } from "@/core/backtest/metrics";
import type { SetupKind } from "@/core/pipeline/types";
import type { BacktestTrade, EquityPoint } from "@/core/backtest/engine";

const DAY = 86_400_000;
export const TRAIN_DAYS = 182; // ~6 months
export const TEST_DAYS = 30; //  1 month
export const HOLDOUT_FRACTION = 0.2;

/** The minimum sample before a training window is allowed to ban a setup. */
export const MIN_TRADES_TO_JUDGE = 10;

export interface Fold {
  readonly index: number;
  readonly trainFrom: number;
  readonly trainTo: number;
  readonly testFrom: number;
  readonly testTo: number;
  readonly train: BacktestOutcome;
  readonly test: BacktestOutcome;
  readonly allowedSetups: readonly SetupKind[];
  readonly trainMetrics: Metrics;
  readonly testMetrics: Metrics;
}

export interface WalkForwardResult {
  readonly folds: readonly Fold[];
  /** Every test fold's trades, concatenated — the only honest headline. */
  readonly outOfSampleTrades: readonly BacktestTrade[];
  readonly outOfSampleMetrics: Metrics;
  readonly perSetup: ReturnType<typeof bySetup>;
  readonly holdoutFrom: number;
  readonly holdoutTo: number;
  readonly arabic: string;
}

/**
 * Where the holdout starts.
 *
 * Computed from the period alone so it cannot drift with the strategy: the
 * same dates are held out no matter how many times the code changes.
 */
export function holdoutBoundary(from: number, to: number): number {
  return to - Math.round((to - from) * HOLDOUT_FRACTION);
}

/** Setups the training window says may trade in the test window. */
export function allowedFromTraining(train: BacktestOutcome): SetupKind[] {
  const allowed: SetupKind[] = [];
  for (const { setup, metrics } of bySetup(train.trades, 1)) {
    // Too few trades to judge is NOT a reason to ban: an unproven setup is
    // unproven, not bad, and banning it would quietly shrink the strategy
    // every time a fold happened to be quiet.
    if (metrics.trades < MIN_TRADES_TO_JUDGE || metrics.expectancyR >= 0) allowed.push(setup);
  }
  return allowed;
}

export function runWalkForward(
  symbols: readonly BacktestSymbol[],
  settings: BacktestSettings,
  from: number,
  to: number,
): WalkForwardResult {
  const boundary = holdoutBoundary(from, to);
  const folds: Fold[] = [];

  let trainFrom = from;
  let index = 0;

  while (trainFrom + (TRAIN_DAYS + TEST_DAYS) * DAY <= boundary) {
    const trainTo = trainFrom + TRAIN_DAYS * DAY;
    const testTo = Math.min(trainTo + TEST_DAYS * DAY, boundary);

    const train = runBacktest(
      symbols,
      { ...settings, allowedSetups: null, seedSetupStats: new Map() },
      trainFrom,
      trainTo,
    );
    const allowedSetups = allowedFromTraining(train);

    const test = runBacktest(
      symbols,
      { ...settings, allowedSetups, seedSetupStats: train.setupStats },
      trainTo,
      testTo,
    );

    folds.push({
      index: index++,
      trainFrom, trainTo, testFrom: trainTo, testTo,
      train, test, allowedSetups,
      trainMetrics: computeMetrics(train.trades, train.equityCurve, settings.startingEquity),
      testMetrics: computeMetrics(test.trades, test.equityCurve, settings.startingEquity),
    });

    // Roll forward by the TEST length, not the train length: consecutive test
    // windows must tile the period without gaps or overlap, or the
    // out-of-sample series is not a series at all.
    trainFrom += TEST_DAYS * DAY;
  }

  const outOfSampleTrades = folds.flatMap((f) => [...f.test.trades]);
  const outOfSampleCurve: EquityPoint[] = folds.flatMap((f) => [...f.test.equityCurve]);
  const outOfSampleMetrics = computeMetrics(
    outOfSampleTrades, outOfSampleCurve, settings.startingEquity,
  );

  const positiveFolds = folds.filter((f) => f.testMetrics.expectancyR > 0).length;

  const arabic = folds.length === 0
    ? "المدّة أقصر من نافذة تدريب واحدة (6 أشهر) زائد شهر اختبار. لا نتيجة."
    : `${folds.length} نافذة اختبار خارج العيّنة، ربحت ${positiveFolds} منها. ` +
      `التوقّع الإجمالي ${outOfSampleMetrics.expectancyR.toFixed(3)}R على ${outOfSampleMetrics.trades} صفقة. ` +
      (positiveFolds <= folds.length / 2
        ? "أغلب النوافذ لم تربح — النتيجة الإجمالية، إن كانت موجبة، محمولة على نوافذ قليلة وليست سلوكاً ثابتاً."
        : "أغلب النوافذ ربحت، وهو ما يعنيه الثبات هنا: النتيجة ليست محمولة على شهر واحد.");

  return {
    folds,
    outOfSampleTrades,
    outOfSampleMetrics,
    perSetup: bySetup(outOfSampleTrades, settings.startingEquity),
    holdoutFrom: boundary,
    holdoutTo: to,
    arabic,
  };
}

/**
 * The single final run.
 *
 * Takes the allowed-setup decision from the LAST training fold, because that
 * is what a live bot starting on the holdout's first day would have known.
 * Deriving it from the holdout itself would defeat the entire purpose of
 * holding it out.
 */
export function runHoldout(
  symbols: readonly BacktestSymbol[],
  settings: BacktestSettings,
  walk: WalkForwardResult,
): BacktestOutcome {
  const last = walk.folds[walk.folds.length - 1];
  return runBacktest(
    symbols,
    {
      ...settings,
      allowedSetups: last ? last.allowedSetups : null,
      seedSetupStats: last ? last.test.setupStats : new Map(),
    },
    walk.holdoutFrom,
    walk.holdoutTo,
  );
}
