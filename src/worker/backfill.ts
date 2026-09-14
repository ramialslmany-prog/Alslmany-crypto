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
import { openDb, closeDb, maintain } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { ArchiveRepo } from "@/storage/repositories/archive";
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

  console.log(`\n${BOLD}بناء التاريخ — منصّة ${cfg.MARKET_EXCHANGE}${RESET}\n`);

  // ── resolve the symbol universe ──────────────────────────────────────────
  let symbols = args.symbols ?? cfg.WATCHLIST;

  if (symbols.length === 0 || args.top) {
    console.log(`${DIM}تحديث قائمة العملات من المنصّة…${RESET}`);
    await ingest.refreshUniverse(0);
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

  // ── summary: report the bad as plainly as the good ───────────────────────
  const archiveRepo = new ArchiveRepo(db);
  const candleRepo = new CandleRepo(db);
  const elapsedMin = (Date.now() - startedAt) / 60_000;

  console.log(`\n${BOLD}الخلاصة${RESET}`);
  console.log(`  ${fmt(candleRepo.count())} شمعة في قاعدة البيانات (${fmt(totalBars)} عبر هذه الجولة)`);
  console.log(`  المدة ${elapsedMin.toFixed(1)} دقيقة`);

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
