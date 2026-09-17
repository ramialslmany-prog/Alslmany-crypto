/**
 * `npm run backtest` — the walk-forward evaluation.
 *
 * Output is ENGLISH, unlike the site and the recommendation reports. Not a
 * style choice: Windows terminals mangle Arabic the moment output is piped or
 * redirected to a file, and the first thing anyone does with a diagnostic
 * this long is redirect it. A report nobody can read diagnoses nothing.
 *
 * Usage:
 *   npm run backtest -- --symbols BTCUSDT,ETHUSDT --timeframe 1h --years 2
 *   npm run backtest -- --symbols BTCUSDT --holdout        # the single final run
 *
 * Reads candles from the local store only. It never fetches: a backtest that
 * downloads as it goes is a backtest whose results depend on when you ran it.
 * Run `npm run backfill` first.
 *
 * THE HOLDOUT IS USED ONCE. The last 20% of the period is reserved, and
 * `--holdout` records each use in `.holdout-log.json`. A second run against
 * the same period prints the previous uses and refuses unless `--again` is
 * passed, because a holdout you keep peeking at is just more training data.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/shared/config";
import { openDb, closeDb } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { DerivativesRepo } from "@/storage/repositories/derivatives";
import { DEFAULT_COSTS } from "@/core/execution/fills";
import { DEFAULT_ELIGIBILITY } from "@/core/pipeline/stage1-eligibility";
import {
  runBacktest, DEFAULT_LOOKBACK_BARS,
  type BacktestOutcome, type BacktestSettings, type BacktestSymbol,
} from "@/core/backtest/engine";
import {
  countFolds, runHoldout, runWalkForward, type WalkForwardResult,
} from "@/core/backtest/walkforward";
import { buyAndHold, bySetup, computeMetrics, funnelVerdict, type Metrics } from "@/core/backtest/metrics";
import { TIMEFRAMES, isTimeframe, type Timeframe } from "@/shared/time";
import type { Candle } from "@/core/types";

const BOLD = "\x1b[1m";
const DIM = "\x1b[90m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const HOLDOUT_LOG = ".holdout-log.json";

/**
 * What each veto means for the operator.
 *
 * A count alone tells you where the runs died; this tells you whether that is
 * the system working or the system stuck, because the two look identical in a
 * bare tally.
 */
const VETO_HINT: Record<string, string> = {
  no_setup_match: "no setup was classified at all — the threshold is not involved",
  score_below_minimum: "setup matched but scored under MIN_FINAL_SCORE — try a lower --min-score",
  risk_reward_too_low: "real targets do not justify the stop distance — try a lower MIN_RISK_REWARD",
  no_valid_stop: "no real invalidation level to hide a stop behind",
  no_valid_target: "nothing ahead and no measurable swing to project from",
  direction_not_allowed: "the macro context forbids this direction",
  stale_data: "data older than maxDataAgeBars allows",
  correlated_exposure: "correlated positions already open",
  exposure_limit: "position cap reached",
  circuit_breaker: "a circuit breaker was active",
};
const DAY = 86_400_000;

interface Args {
  symbols: string[];
  timeframe: Timeframe;
  years: number;
  equity: number;
  minScore: number | null;
  holdout: boolean;
  again: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tf = get("--timeframe") ?? "1h";
  if (!isTimeframe(tf)) throw new Error(`Unknown timeframe: ${tf}. Allowed: ${TIMEFRAMES.join(", ")}`);

  return {
    symbols: (get("--symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    timeframe: tf,
    years: Number(get("--years") ?? 2),
    equity: get("--equity") ? Number(get("--equity")) : 0,
    minScore: get("--min-score") ? Number(get("--min-score")) : null,
    holdout: argv.includes("--holdout"),
    again: argv.includes("--again"),
    json: get("--json") ?? null,
  };
}

const n2 = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${n2(Math.abs(x))}%`;

function loadSymbol(
  candleRepo: CandleRepo, symbolRepo: SymbolRepo, derivRepo: DerivativesRepo,
  exchange: string, symbol: string,
): BacktestSymbol | null {
  const info = symbolRepo.get(exchange, "spot", symbol);
  if (!info) {
    console.log(
      `${YELLOW}Skipping ${symbol}: not in the symbol table.${RESET}\n` +
      `  ${DIM}Run: npm run backfill -- --symbols ${symbol} --years 3${RESET}\n` +
      `  ${DIM}If you already did, it likely predates a fix to that command — run it again; ` +
      `it resumes rather than re-downloading.${RESET}`,
    );
    return null;
  }

  const candles: Partial<Record<Timeframe, readonly Candle[]>> = {};
  let earliest: number | null = null;
  for (const tf of TIMEFRAMES) {
    // A very large limit, because the engine does its own point-in-time
    // slicing: reading less here would silently shorten the warm-up.
    const rows = candleRepo.latest(symbol, tf, 200_000);
    if (rows.length === 0) continue;
    candles[tf] = rows;
    if (earliest === null || rows[0].openTime < earliest) earliest = rows[0].openTime;
  }

  if (Object.keys(candles).length === 0) {
    console.log(`${YELLOW}Skipping ${symbol}: no stored candles.${RESET}`);
    return null;
  }

  // Derivatives, when the archive was imported. Absent is reported, never
  // faked: the stage then degrades exactly as it does live without a provider.
  const coverage = derivRepo.coverage(symbol);
  const derivatives = coverage
    ? {
        openInterest: derivRepo.openInterest(symbol, Infinity, 1_000_000),
        longShort: derivRepo.longShort(symbol, Infinity, 1_000_000),
        funding: derivRepo.funding(symbol, Infinity, 100_000),
        liquidations: derivRepo.liquidations(symbol, 0, Infinity),
      }
    : null;

  if (!coverage) {
    console.log(
      `  ${DIM}${symbol}: no derivatives history — stage 5 will run on CVD alone. ` +
      `Import it with npm run backfill.${RESET}`,
    );
  }

  return { symbol, info, listedAt: info.listedAt ?? earliest, candles, derivatives };
}

function printMetrics(label: string, m: Metrics): void {
  console.log(`${BOLD}${label}${RESET}`);
  console.log(`  trades ${m.trades} · won ${m.wins} · lost ${m.losses} · win rate ${n2(m.winRate * 100, 1)}%`);
  console.log(`  expectancy ${n2(m.expectancyR, 3)}R per trade · total ${n2(m.totalR, 2)}R`);
  console.log(`  avg win ${n2(m.averageWinR, 2)}R · avg loss ${n2(m.averageLossR, 2)}R`);
  console.log(
    `  profit factor ${m.profitFactor === null ? "— (no losses yet)" : n2(m.profitFactor)} · ` +
    `return ${pct(m.returnPct)} · max drawdown ${n2(m.maxDrawdownPct)}%`,
  );
  console.log(`  longest losing streak ${m.longestLosingStreak} · avg hold ${n2(m.averageBarsHeld, 1)} bars`);
  if (m.trades > 0) console.log(`  ${DIM}avg heat taken by winners ${n2(m.averageHeatR, 2)}R${RESET}`);
}

function printOutcome(
  out: BacktestOutcome, equity: number, symbols: readonly BacktestSymbol[],
  tf: Timeframe, minScoreUsed: number,
): void {
  const funnel = funnelVerdict(out);
  console.log(`${BOLD}FUNNEL${RESET}`);
  console.log(
    `  ${out.funnel.analyses} analyses · ${out.funnel.recommendations} recommendations · ` +
    `${out.funnel.riskBlocked} blocked by portfolio risk · ${out.funnel.setupDisallowed} blocked by training`,
  );
  console.log(`  ${funnel.arabic}`);
  const died = Object.entries(out.funnel.failedAt).sort((a, b) => b[1] - a[1]);
  if (died.length) {
    console.log(`  ${DIM}where they died: ${died.map(([k, v]) => `${k} ${v}`).join(" · ")}${RESET}`);
  }

  // "Died at the council" is not a diagnosis — the council has ten ways to
  // say no, and they call for opposite fixes.
  const vetoes = Object.entries(out.funnel.vetoes).sort((a, b) => b[1] - a[1]);
  if (vetoes.length) {
    console.log(`  ${BOLD}WHICH VETO FIRED${RESET}`);
    for (const [id, count] of vetoes) {
      console.log(`    ${id.padEnd(24)} ${String(count).padStart(6)}×   ${DIM}${VETO_HINT[id] ?? ""}${RESET}`);
    }
  }

  // The score distribution turns "the threshold rejected everything" into an
  // answerable question: by how much, and what would it take to pass?
  const scores = [...out.setupScores].sort((a, b) => a - b);
  if (scores.length > 0) {
    const at = (q: number) => scores[Math.min(scores.length - 1, Math.floor(scores.length * q))];
    const threshold = out.funnel.recommendations >= 0 ? minScoreUsed : minScoreUsed;
    const passing = scores.filter((v) => v >= threshold).length;
    console.log(`${BOLD}FINAL-SCORE DISTRIBUTION${RESET} ${DIM}(runs that named a setup: ${scores.length})${RESET}`);
    console.log(
      `  median ${n2(at(0.5), 1)} · p90 ${n2(at(0.9), 1)} · p99 ${n2(at(0.99), 1)} · ` +
      `max ${n2(scores[scores.length - 1], 1)}`,
    );
    console.log(
      `  the current threshold ${threshold} passes ${n2((passing / scores.length) * 100, 1)}% of them ` +
      `(${passing} runs)`,
    );
    if (passing === 0) {
      console.log(
        `  ${YELLOW}Not one run reaches the threshold. The highest score this system produced on ` +
        `this data is ${n2(scores[scores.length - 1], 1)} — the threshold is above its ceiling, ` +
        `not merely a little above its typical.${RESET}`,
      );
    } else if (out.funnel.recommendations === 0) {
      console.log(
        `  ${YELLOW}Runs cleared the threshold and still produced nothing — so the blocker is ` +
        `AFTER the score. See the veto table above.${RESET}`,
      );
    }
  }

  printMetrics("RESULT", computeMetrics(out.trades, out.equityCurve, equity));

  const setups = bySetup(out.trades, equity);
  if (setups.length) {
    console.log(`${BOLD}BY SETUP${RESET}`);
    for (const row of setups) {
      const flag = row.metrics.trades < 20 ? ` ${YELLOW}(small sample)${RESET}` : "";
      console.log(
        `  ${row.setup.padEnd(22)} ${String(row.metrics.trades).padStart(4)} trades · ` +
        `expectancy ${n2(row.metrics.expectancyR, 3)}R · win ${n2(row.metrics.winRate * 100, 0)}%${flag}`,
      );
    }
  }

  console.log(`${BOLD}VS BUY AND HOLD${RESET}`);
  for (const sym of symbols) {
    const bh = buyAndHold(sym.symbol, sym.candles[tf] ?? [], out.from, out.to, DEFAULT_COSTS.takerFeeBps);
    if (bh) {
      console.log(`  ${sym.symbol.padEnd(12)} ${pct(bh.returnPct).padStart(10)} · max drawdown ${n2(bh.maxDrawdownPct)}%`);
    }
  }

  if (out.breakersTripped.length) {
    console.log(`${BOLD}${YELLOW}CIRCUIT BREAKERS${RESET}`);
    for (const b of out.breakersTripped) console.log(`  ${iso(b.trippedAt)} — ${b.arabic.split(".")[0]}.`);
  }

  console.log(`${BOLD}WHAT THIS RESULT DOES NOT COVER${RESET}`);
  for (const c of out.caveats) console.log(`  ${DIM}• ${c}${RESET}`);
}

interface HoldoutUse {
  at: string;
  symbols: string[];
  timeframe: string;
  from: string;
  to: string;
  trades: number;
  expectancyR: number;
}

function readHoldoutLog(): HoldoutUse[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), HOLDOUT_LOG), "utf8")) as HoldoutUse[];
  } catch {
    return [];
  }
}

function appendHoldoutLog(use: HoldoutUse): void {
  const all = [...readHoldoutLog(), use];
  fs.writeFileSync(path.join(process.cwd(), HOLDOUT_LOG), `${JSON.stringify(all, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.symbols.length === 0) {
    console.error("No symbols. Example: npm run backtest -- --symbols BTCUSDT,ETHUSDT --timeframe 1h --years 2");
    process.exitCode = 1;
    return;
  }

  const cfg = getConfig();
  const equity = args.equity > 0 ? args.equity : cfg.PAPER_STARTING_EQUITY;
  const db = openDb(cfg.dbPath);
  const candleRepo = new CandleRepo(db);
  const symbolRepo = new SymbolRepo(db);
  const derivRepo = new DerivativesRepo(db);

  try {
    const symbols = args.symbols
      .map((s) => loadSymbol(candleRepo, symbolRepo, derivRepo, cfg.MARKET_EXCHANGE, s))
      .filter((s): s is BacktestSymbol => s !== null);

    if (symbols.length === 0) {
      console.error("No usable data. Run npm run backfill first.");
      process.exitCode = 1;
      return;
    }
    if (!symbols.some((s) => s.symbol.startsWith("BTC"))) {
      console.log(
        `${YELLOW}Warning: Bitcoin is not included. Stage 2 needs BTC history, and without it ` +
        `every analysis stops at the macro context.${RESET}`,
      );
    }

    const tfCandles = symbols.flatMap((s) => s.candles[args.timeframe] ?? []);
    if (tfCandles.length === 0) {
      console.error(`No candles on the ${args.timeframe} timeframe.`);
      process.exitCode = 1;
      return;
    }
    const newest = Math.max(...tfCandles.map((c) => c.closeTime));
    const to = newest;
    const from = to - args.years * 365 * DAY;

    const settings: BacktestSettings = {
      tradingTimeframe: args.timeframe,
      exchange: cfg.MARKET_EXCHANGE,
      hasTakerBreakdown: true,
      startingEquity: equity,
      riskPercent: cfg.RISK_PER_TRADE_PCT,
      correlationCeiling: cfg.MAX_BTC_CORRELATION_FOR_INDEPENDENCE,
      limits: {
        riskPerTradePct: cfg.RISK_PER_TRADE_PCT,
        maxOpenPositions: cfg.MAX_OPEN_POSITIONS,
        maxCorrelatedPositions: cfg.MAX_CORRELATED_POSITIONS,
        correlationThreshold: cfg.CORRELATION_THRESHOLD,
        dailyLossHaltPct: cfg.DAILY_LOSS_HALT_PCT,
        dailyHaltHours: cfg.DAILY_HALT_HOURS,
        maxDrawdownHaltPct: cfg.MAX_DRAWDOWN_HALT_PCT,
      },
      council: {
        minFinalScore: args.minScore ?? cfg.MIN_FINAL_SCORE,
        minRiskReward: cfg.MIN_RISK_REWARD,
        maxOpenPositions: cfg.MAX_OPEN_POSITIONS,
        maxCorrelatedPositions: cfg.MAX_CORRELATED_POSITIONS,
        correlationThreshold: cfg.CORRELATION_THRESHOLD,
        maxDataAgeBars: 3,
      },
      // The one deviation from live, made loudly: no archive stores order
      // books, so the spread and depth gates are skipped rather than faked.
      eligibility: { ...DEFAULT_ELIGIBILITY, requireLiveBook: false },
      costs: DEFAULT_COSTS,
      lookbackBars: DEFAULT_LOOKBACK_BARS,
      fearGreedHistory: [],
      allowedSetups: null,
      seedSetupStats: new Map(),
    };

    console.log(
      `${BOLD}BACKTEST — ${symbols.map((s) => s.symbol).join(", ")} · ` +
      `${args.timeframe} · ${iso(from)} to ${iso(to)}${RESET}\n`,
    );

    const totalFolds = countFolds(from, to);
    const startedAt = Date.now();
    console.log(
      `${DIM}${totalFolds} folds · each is 6 months of training and 1 month of testing. ` +
      `The real work is hundreds of thousands of full analyses, so expect this to take a while.${RESET}\n`,
    );

    const walk: WalkForwardResult = runWalkForward(symbols, settings, from, to, (p) => {
      const label = p.phase === "train" ? "train" : "test ";
      const head = `${DIM}[${String(p.fold + 1).padStart(2)}/${totalFolds}]${RESET} ${label} ${iso(p.from)}→${iso(p.to)}`;
      if (p.trades === null) {
        // Carriage return, no newline: the finished line overwrites this one.
        process.stdout.write(`\r${head} …   `);
      } else {
        const mins = (Date.now() - startedAt) / 60_000;
        process.stdout.write(`\r${head} · ${p.trades} trades ${DIM}(${mins.toFixed(1)} min)${RESET}\n`);
      }
    });
    console.log("");

    console.log(`${BOLD}WALK FORWARD${RESET}`);
    console.log(`  ${walk.arabic}`);
    for (const f of walk.folds) {
      console.log(
        `  ${DIM}fold ${String(f.index + 1).padStart(2)} · train ${iso(f.trainFrom)}→${iso(f.trainTo)} ` +
        `(${f.trainMetrics.trades} trades, ${n2(f.trainMetrics.expectancyR, 2)}R) · ` +
        `test ${iso(f.testFrom)}→${iso(f.testTo)} ` +
        `(${f.testMetrics.trades} trades, ${n2(f.testMetrics.expectancyR, 2)}R)${RESET}`,
      );
    }
    console.log("");
    printMetrics("OUT OF SAMPLE (all test folds)", walk.outOfSampleMetrics);
    console.log("");

    // A single-window run over the non-holdout period, for the funnel and the
    // caveats — the walk-forward's folds do not produce one combined funnel.
    const whole = runBacktest(symbols, settings, from, walk.holdoutFrom);
    printOutcome(whole, equity, symbols, args.timeframe, settings.council.minFinalScore);

    console.log(
      `\n${DIM}Holdout: ${iso(walk.holdoutFrom)} to ${iso(walk.holdoutTo)} — untouched. ` +
      `Run --holdout ONCE, after every decision is made.${RESET}`,
    );

    if (args.holdout) {
      const previous = readHoldoutLog().filter(
        (u) => u.timeframe === args.timeframe && u.from === iso(walk.holdoutFrom),
      );
      if (previous.length > 0 && !args.again) {
        console.log(`\n${YELLOW}${BOLD}The holdout has already been used on this window:${RESET}`);
        for (const u of previous) {
          console.log(`  ${u.at} — ${u.trades} trades, expectancy ${n2(u.expectancyR, 3)}R`);
        }
        console.log(
          `${YELLOW}This refusal is deliberate: a holdout you keep peeking at is just more ` +
          `training data. Pass --again to override on purpose.${RESET}`,
        );
      } else {
        console.log(`\n${BOLD}FINAL USE OF THE HOLDOUT${RESET}`);
        const holdout = runHoldout(symbols, settings, walk);
        printOutcome(holdout, equity, symbols, args.timeframe, settings.council.minFinalScore);
        const m = computeMetrics(holdout.trades, holdout.equityCurve, equity);
        appendHoldoutLog({
          at: new Date().toISOString(),
          symbols: symbols.map((s) => s.symbol),
          timeframe: args.timeframe,
          from: iso(walk.holdoutFrom),
          to: iso(walk.holdoutTo),
          trades: m.trades,
          expectancyR: Number(m.expectancyR.toFixed(4)),
        });
        console.log(`\n${DIM}This use was recorded in ${HOLDOUT_LOG}.${RESET}`);
      }
    }

    if (args.json) {
      fs.writeFileSync(args.json, `${JSON.stringify({
        from, to, timeframe: args.timeframe,
        symbols: symbols.map((s) => s.symbol),
        outOfSample: walk.outOfSampleMetrics,
        folds: walk.folds.map((f) => ({
          index: f.index, testFrom: f.testFrom, testTo: f.testTo,
          metrics: f.testMetrics, allowedSetups: f.allowedSetups,
        })),
        perSetup: walk.perSetup,
        funnel: whole.funnel,
        caveats: whole.caveats,
      }, null, 2)}\n`);
      console.log(`${DIM}Results written to ${args.json}${RESET}`);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
