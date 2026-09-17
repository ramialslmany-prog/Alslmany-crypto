/**
 * `npm run backfill` — build the historical candle store.
 *
 * Usage:
 *   npm run backfill -- --symbols BTCUSDT,ETHUSDT --timeframes 1h,4h,1d --years 3
 *   npm run backfill -- --top 50 --timeframes 1d --years 5
 *
 * Resumable by design: the archive manifest records what was imported and what
 * the venue does not publish, so re-running after an interruption picks up
 * where it stopped instead of re-downloading gigabytes.
 */
import { getConfig } from "@/shared/config";
import { createMarketSource } from "@/data/exchanges";
import { Ingestor } from "@/data/ingest";
import { DerivativesIngestor } from "@/data/derivatives-ingest";
import { openDb, closeDb, maintain } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { ArchiveRepo } from "@/storage/repositories/archive";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { createLogger } from "@/shared/logger";
import { TIMEFRAMES, type Timeframe, isTimeframe } from "@/shared/time";

const log = createLogger("backfill");
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface Args {
  symbols?: string[];
  timeframes: Timeframe[];
  years: number;
  top?: number;
  noArchive: boolean;
  noDerivatives: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tfRaw = get("--timeframes");
  const timeframes = tfRaw
    ? tfRaw.split(",").map((s) => s.trim()).filter(isTimeframe)
    : [...TIMEFRAMES];

  if (tfRaw && timeframes.length === 0) {
    throw new Error(`أطر زمنية غير معروفة: ${tfRaw}. المسموح: ${TIMEFRAMES.join(", ")}`);
  }

  return {
    symbols: get("--symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    timeframes,
    years: Number(get("--years") ?? 2),
    top: get("--top") ? Number(get("--top")) : undefined,
    noArchive: argv.includes("--no-archive"),
    noDerivatives: argv.includes("--no-derivatives"),
  };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const iso = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "—");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  const db = openDb(cfg.dbPath);
  const source = createMarketSource(cfg);
  const ingest = new Ingestor(db, cfg, source);
  const derivatives = new DerivativesIngestor(db, cfg, source);

  console.log(`\n${BOLD}بناء التاريخ — منصّة ${cfg.MARKET_EXCHANGE}${RESET}\n`);

  // ── resolve the symbol universe ──────────────────────────────────────────
  let symbols = args.symbols ?? cfg.WATCHLIST;

  // ALWAYS refresh the symbol table, even for an explicit --symbols list.
  //
  // It used to be skipped whenever --symbols was given, which stored the
  // candles and nothing else: the backtester and the bot both look a symbol
  // up in this table first, so a perfectly good backfill produced a database
  // they then refused to read, with a message telling the user to run the
  // backfill they had just run.
  console.log(`${DIM}تحديث قائمة العملات من المنصّة…${RESET}`);
  await ingest.refreshUniverse(0);

  if (symbols.length === 0 || args.top) {
    const ticker = await source.ticker24h();
    if (!ticker.available) {
      console.error(`تعذّر جلب قائمة الأحجام: ${ticker.detail ?? ticker.reason}`);
      process.exit(1);
    }
    // Rank by real quote volume — the only ordering that reflects tradability.
    symbols = ticker.value
      .filter((t) => t.symbol.endsWith(cfg.QUOTE_ASSET) && Number.isFinite(t.quoteVolume))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, args.top ?? cfg.UNIVERSE_MAX_SYMBOLS)
      .map((t) => t.symbol);
  }

  const from = Date.now() - args.years * 365 * 86_400_000;
  const jobs = symbols.length * args.timeframes.length;

  console.log(
    `${fmt(symbols.length)} عملة × ${args.timeframes.length} إطار = ${fmt(jobs)} سلسلة\n` +
      `من ${iso(from)} حتى الآن${args.noArchive ? ` ${YELLOW}(بدون أرشيف)${RESET}` : ""}\n`,
  );

  let done = 0;
  let totalBars = 0;
  const failures: string[] = [];
  const startedAt = Date.now();

  for (const symbol of symbols) {
    for (const timeframe of args.timeframes) {
      done++;
      const label = `${symbol} ${timeframe}`.padEnd(20);
      process.stdout.write(`${DIM}[${String(done).padStart(4)}/${jobs}]${RESET} ${label} `);

      const report = await ingest.backfill(symbol, timeframe, from, {
        useArchive: !args.noArchive,
        onProgress: (i, total, key) => {
          if (total > 0 && i < total) {
            process.stdout.write(`\r${DIM}[${String(done).padStart(4)}/${jobs}]${RESET} ${label} ${DIM}${key} (${i}/${total})${RESET}   `);
          }
        },
      });

      totalBars += report.totalStored;
      const unverified = report.archiveUnverified > 0 ? ` ${YELLOW}${report.archiveUnverified} بلا تحقّق${RESET}` : "";
      const gaps = report.gaps > 0 ? ` ${YELLOW}${report.gaps} فجوة${RESET}` : "";

      process.stdout.write(
        `\r${DIM}[${String(done).padStart(4)}/${jobs}]${RESET} ${label} ` +
          `${String(fmt(report.totalStored)).padStart(9)} شمعة · ${iso(report.first)} → ${iso(report.last)}` +
          `${unverified}${gaps}\n`,
      );

      if (report.errors.length) {
        failures.push(`${symbol} ${timeframe}: ${report.errors.slice(0, 2).join("; ")}`);
      }
    }
  }

  // ── derivatives: open interest and the long/short ratios ────────────────
  //
  // Stage 5 reads these live. Without them here it is "unavailable" in every
  // backtest, and the backtest stops testing the strategy that trades.
  if (!args.noDerivatives) {
    console.log(`\n${BOLD}المشتقّات — العقود المفتوحة ونسب الطويل/القصير${RESET}`);
    for (const symbol of symbols) {
      process.stdout.write(`${DIM}[derivatives]${RESET} ${symbol.padEnd(14)} `);
      const report = await derivatives.backfill(symbol, from, Date.now(), (i, total, key) => {
        if (i % 10 === 0 || i === total) {
          process.stdout.write(`\r${DIM}[derivatives]${RESET} ${symbol.padEnd(14)} ${DIM}${key} (${i}/${total})${RESET}   `);
        }
      });
      const note = report.missing > 0 ? ` ${DIM}${report.missing} يوم بلا ملف${RESET}` : "";
      const liqNote = report.liquidationAbandoned
        ? ` ${YELLOW}(لا أرشيف تصفيات لهذه العملة — توقّف الفحص مبكراً)${RESET}`
        : report.liquidationEmpty > 0
          ? ` ${YELLOW}(${report.liquidationEmpty} ملف تصفيات وصل بلا صفوف مقروءة)${RESET}`
          : "";
      process.stdout.write(
        `\r${DIM}[derivatives]${RESET} ${symbol.padEnd(14)} ` +
        `${String(fmt(report.imported)).padStart(9)} قراءة · ${fmt(report.liquidationRows)} تصفية · ` +
        `${report.fundingRows} تمويل${note}${liqNote}\n`,
      );
      if (report.failed > 0 || report.liquidationEmpty > 0) {
        for (const e of report.errors.slice(0, 3)) failures.push(`${symbol} derivatives: ${e}`);
      }
    }
  }

  // ── listing dates, now that the candles exist ────────────────────────────
  //
  // This has to happen AFTER the backfill, not before: the listing date is
  // read from the first stored daily bar, and before the backfill there are
  // none. Getting the order wrong left every symbol with an unknown listing
  // date — and stage 1 rejects an unknown date by design, so the bot would
  // have refused every coin it had just spent an hour downloading.
  const symbolRepo = new SymbolRepo(db);
  const candleRepoForDates = new CandleRepo(db);
  let dated = 0;
  for (const symbol of symbols) {
    const info = symbolRepo.get(cfg.MARKET_EXCHANGE, "spot", symbol);
    if (!info || info.listedAt) continue;
    // Daily first, then any timeframe that has history.
    const coverage =
      candleRepoForDates.coverage(symbol, "1d") ??
      args.timeframes.map((tf) => candleRepoForDates.coverage(symbol, tf)).find((c) => c != null);
    if (coverage) {
      symbolRepo.setListedAt(cfg.MARKET_EXCHANGE, "spot", symbol, coverage.first);
      dated++;
    }
  }

  // ── summary: report the bad as plainly as the good ───────────────────────
  const archiveRepo = new ArchiveRepo(db);
  const candleRepo = new CandleRepo(db);
  const elapsedMin = (Date.now() - startedAt) / 60_000;

  console.log(`\n${BOLD}الخلاصة${RESET}`);
  console.log(`  ${fmt(candleRepo.count())} شمعة في قاعدة البيانات (${fmt(totalBars)} عبر هذه الجولة)`);
  console.log(`  المدة ${elapsedMin.toFixed(1)} دقيقة`);
  console.log(`  ${fmt(symbols.length)} عملة في جدول العملات · ${fmt(dated)} حُدّد تاريخ إدراجها من أول شمعة مخزّنة`);

  console.log(`\n${BOLD}ملفات الأرشيف${RESET}`);
  for (const row of archiveRepo.summary()) {
    console.log(`  ${row.status.padEnd(12)} ${String(fmt(row.count)).padStart(6)} ملف · ${fmt(row.rows)} شمعة`);
  }

  const unverified = archiveRepo.unverified();
  if (unverified.length) {
    console.log(
      `\n  ${YELLOW}تنبيه:${RESET} ${unverified.length} ملف استُورد دون التحقّق من بصمته.\n` +
        `  ${DIM}هذه البيانات مستخدمة لكنها غير مُثبتة — تظهر كذلك في صفحة الصحة.${RESET}`,
    );
  }

  if (failures.length) {
    console.log(`\n${YELLOW}${failures.length} سلسلة بها أخطاء:${RESET}`);
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
    if (failures.length > 20) console.log(`  ${DIM}… و${failures.length - 20} أخرى${RESET}`);
  }

  maintain(db);
  closeDb();
  log.info("backfill complete", { series: jobs, failures: failures.length });
  console.log("");
}

main().catch((err) => {
  console.error("فشل البناء:", err);
  process.exit(1);
});
