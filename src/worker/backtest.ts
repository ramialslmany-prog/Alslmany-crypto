/**
 * `npm run backtest` — the walk-forward evaluation.
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
import { DEFAULT_COSTS } from "@/core/execution/fills";
import { DEFAULT_ELIGIBILITY } from "@/core/pipeline/stage1-eligibility";
import {
  runBacktest, DEFAULT_LOOKBACK_BARS,
  type BacktestOutcome, type BacktestSettings, type BacktestSymbol,
} from "@/core/backtest/engine";
import { runHoldout, runWalkForward, type WalkForwardResult } from "@/core/backtest/walkforward";
import { buyAndHold, bySetup, computeMetrics, funnelVerdict, type Metrics } from "@/core/backtest/metrics";
import { TIMEFRAMES, isTimeframe, type Timeframe } from "@/shared/time";
import type { Candle } from "@/core/types";

const BOLD = "\x1b[1m";
const DIM = "\x1b[90m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const HOLDOUT_LOG = ".holdout-log.json";
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
  if (!isTimeframe(tf)) throw new Error(`إطار زمني غير معروف: ${tf}. المسموح: ${TIMEFRAMES.join(", ")}`);

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
  candleRepo: CandleRepo, symbolRepo: SymbolRepo, exchange: string, symbol: string,
): BacktestSymbol | null {
  const info = symbolRepo.get(exchange, "spot", symbol);
  if (!info) {
    console.log(
      `${YELLOW}تخطّي ${symbol}: غير موجودة في جدول العملات.${RESET}\n` +
      `  ${DIM}شغّل: npm run backfill -- --symbols ${symbol} --years 3${RESET}\n` +
      `  ${DIM}إن كنت قد شغّلته فعلاً، فالأرجح أنه سبق إصلاحاً في هذا الملف — أعِد تشغيله، ` +
      `فهو يستأنف ولا يُعيد التحميل.${RESET}`,
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
    console.log(`${YELLOW}تخطّي ${symbol}: لا شموع مخزّنة.${RESET}`);
    return null;
  }

  return { symbol, info, listedAt: info.listedAt ?? earliest, candles };
}

function printMetrics(label: string, m: Metrics): void {
  console.log(`${BOLD}${label}${RESET}`);
  console.log(`  صفقات ${m.trades} · رابحة ${m.wins} · خاسرة ${m.losses} · نسبة النجاح ${n2(m.winRate * 100, 1)}%`);
  console.log(`  التوقّع ${n2(m.expectancyR, 3)}R لكل صفقة · إجمالي ${n2(m.totalR, 2)}R`);
  console.log(`  متوسط الرابحة ${n2(m.averageWinR, 2)}R · متوسط الخاسرة ${n2(m.averageLossR, 2)}R`);
  console.log(
    `  معامل الربح ${m.profitFactor === null ? "— (لا خسائر بعد)" : n2(m.profitFactor)} · ` +
    `العائد ${pct(m.returnPct)} · أقصى تراجع ${n2(m.maxDrawdownPct)}%`,
  );
  console.log(`  أطول سلسلة خسائر ${m.longestLosingStreak} · متوسط المدّة ${n2(m.averageBarsHeld, 1)} شمعة`);
  if (m.trades > 0) console.log(`  ${DIM}متوسط الضغط على الصفقات الرابحة ${n2(m.averageHeatR, 2)}R${RESET}`);
}

function printOutcome(out: BacktestOutcome, equity: number, symbols: readonly BacktestSymbol[], tf: Timeframe): void {
  const funnel = funnelVerdict(out);
  console.log(`${BOLD}القمع${RESET}`);
  console.log(
    `  ${out.funnel.analyses} تحليلاً · ${out.funnel.recommendations} توصية · ` +
    `${out.funnel.riskBlocked} منعتها حماية المحفظة · ${out.funnel.setupDisallowed} منعها التدريب`,
  );
  console.log(`  ${funnel.arabic}`);
  const died = Object.entries(out.funnel.failedAt).sort((a, b) => b[1] - a[1]);
  if (died.length) {
    console.log(`  ${DIM}أين سقطت: ${died.map(([k, v]) => `${k} ${v}`).join(" · ")}${RESET}`);
  }

  printMetrics("النتيجة", computeMetrics(out.trades, out.equityCurve, equity));

  const setups = bySetup(out.trades, equity);
  if (setups.length) {
    console.log(`${BOLD}حسب النمط${RESET}`);
    for (const row of setups) {
      const flag = row.metrics.trades < 20 ? ` ${YELLOW}(عيّنة صغيرة)${RESET}` : "";
      console.log(
        `  ${row.setup.padEnd(22)} ${String(row.metrics.trades).padStart(4)} صفقة · ` +
        `توقّع ${n2(row.metrics.expectancyR, 3)}R · نجاح ${n2(row.metrics.winRate * 100, 0)}%${flag}`,
      );
    }
  }

  console.log(`${BOLD}مقارنة بالشراء والاحتفاظ${RESET}`);
  for (const sym of symbols) {
    const bh = buyAndHold(sym.symbol, sym.candles[tf] ?? [], out.from, out.to, DEFAULT_COSTS.takerFeeBps);
    if (bh) {
      console.log(`  ${sym.symbol.padEnd(12)} ${pct(bh.returnPct).padStart(10)} · أقصى تراجع ${n2(bh.maxDrawdownPct)}%`);
    }
  }

  if (out.breakersTripped.length) {
    console.log(`${BOLD}${YELLOW}قواطع الحماية${RESET}`);
    for (const b of out.breakersTripped) console.log(`  ${iso(b.trippedAt)} — ${b.arabic.split(".")[0]}.`);
  }

  console.log(`${BOLD}ما لا تغطّيه هذه النتيجة${RESET}`);
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
    console.error("لا عملات. مثال: npm run backtest -- --symbols BTCUSDT,ETHUSDT --timeframe 1h --years 2");
    process.exitCode = 1;
    return;
  }

  const cfg = getConfig();
  const equity = args.equity > 0 ? args.equity : cfg.PAPER_STARTING_EQUITY;
  const db = openDb(cfg.dbPath);
  const candleRepo = new CandleRepo(db);
  const symbolRepo = new SymbolRepo(db);

  try {
    const symbols = args.symbols
      .map((s) => loadSymbol(candleRepo, symbolRepo, cfg.MARKET_EXCHANGE, s))
      .filter((s): s is BacktestSymbol => s !== null);

    if (symbols.length === 0) {
      console.error("لا بيانات صالحة. شغّل npm run backfill أولاً.");
      process.exitCode = 1;
      return;
    }
    if (!symbols.some((s) => s.symbol.startsWith("BTC"))) {
      console.log(
        `${YELLOW}تنبيه: البيتكوين غير مضمّنة. المرحلة الثانية تحتاج تاريخ البيتكوين، ` +
        `وبدونه سيسقط كل تحليل عند السياق الكلي.${RESET}`,
      );
    }

    const tfCandles = symbols.flatMap((s) => s.candles[args.timeframe] ?? []);
    if (tfCandles.length === 0) {
      console.error(`لا شموع على إطار ${args.timeframe}.`);
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
      `${BOLD}اختبار خلفي — ${symbols.map((s) => s.symbol).join("، ")} · ` +
      `${args.timeframe} · ${iso(from)} إلى ${iso(to)}${RESET}\n`,
    );

    const walk: WalkForwardResult = runWalkForward(symbols, settings, from, to);

    console.log(`${BOLD}التدحرج الأمامي${RESET}`);
    console.log(`  ${walk.arabic}`);
    for (const f of walk.folds) {
      console.log(
        `  ${DIM}نافذة ${String(f.index + 1).padStart(2)} · تدريب ${iso(f.trainFrom)}→${iso(f.trainTo)} ` +
        `(${f.trainMetrics.trades} صفقة، ${n2(f.trainMetrics.expectancyR, 2)}R) · ` +
        `اختبار ${iso(f.testFrom)}→${iso(f.testTo)} ` +
        `(${f.testMetrics.trades} صفقة، ${n2(f.testMetrics.expectancyR, 2)}R)${RESET}`,
      );
    }
    console.log("");
    printMetrics("خارج العيّنة (كل نوافذ الاختبار)", walk.outOfSampleMetrics);
    console.log("");

    // A single-window run over the non-holdout period, for the funnel and the
    // caveats — the walk-forward's folds do not produce one combined funnel.
    const whole = runBacktest(symbols, settings, from, walk.holdoutFrom);
    printOutcome(whole, equity, symbols, args.timeframe);

    console.log(
      `\n${DIM}المحجوز: ${iso(walk.holdoutFrom)} إلى ${iso(walk.holdoutTo)} — ` +
      `لم يُلمس. شغّل --holdout مرة واحدة فقط بعد اتخاذ كل القرارات.${RESET}`,
    );

    if (args.holdout) {
      const previous = readHoldoutLog().filter(
        (u) => u.timeframe === args.timeframe && u.from === iso(walk.holdoutFrom),
      );
      if (previous.length > 0 && !args.again) {
        console.log(`\n${YELLOW}${BOLD}المحجوز استُخدم من قبل على هذه النافذة:${RESET}`);
        for (const u of previous) {
          console.log(`  ${u.at} — ${u.trades} صفقة، توقّع ${n2(u.expectancyR, 3)}R`);
        }
        console.log(
          `${YELLOW}الرفض متعمَّد: مجموعة محجوزة تُفحص مراراً تتحوّل إلى بيانات تدريب. ` +
          `لتجاوز ذلك عن قصد أضف --again.${RESET}`,
        );
      } else {
        console.log(`\n${BOLD}الاستخدام النهائي للمجموعة المحجوزة${RESET}`);
        const holdout = runHoldout(symbols, settings, walk);
        printOutcome(holdout, equity, symbols, args.timeframe);
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
        console.log(`\n${DIM}سُجّل هذا الاستخدام في ${HOLDOUT_LOG}.${RESET}`);
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
      console.log(`${DIM}كُتبت النتائج إلى ${args.json}${RESET}`);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
