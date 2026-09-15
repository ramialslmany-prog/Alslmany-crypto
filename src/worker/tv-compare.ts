/**
 * `npm run tv` — print our RSI(14), SMA(200) and EMA(200) next to everything
 * needed to check them against TradingView by hand.
 *
 *   npm run tv
 *   npm run tv -- --symbols BTCUSDT,ETHUSDT,SOLUSDT --timeframes 1h,4h,1d
 *
 * WHY THIS EXISTS: the unit tests prove our indicators match a second
 * implementation of their definitions. They cannot prove we agree with the
 * chart the user is actually looking at. Only this can.
 *
 * THE ONE THING THAT MAKES OR BREAKS THE COMPARISON: TradingView's last bar is
 * still FORMING, and its RSI moves every tick. We compute on CLOSED bars only.
 * So the output below names the exact closed bar to compare against, and also
 * prints the previous one — if our value matches TradingView's second-to-last
 * bar, the numbers agree and the only difference is which bar you are reading.
 */
import { getConfig } from "@/shared/config";
import { createMarketSource } from "@/data/exchanges";
import { ema, rsi, sma } from "@/core/indicators";
import { type Timeframe, dropUnclosed, isTimeframe } from "@/shared/time";

const BOLD = "\x1b[1m";
const DIM = "\x1b[90m";
const AMBER = "\x1b[33m";
const RESET = "\x1b[0m";

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Enough history that SMA(200) is warmed up with room to spare. */
const BARS = 700;

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const source = createMarketSource(cfg);

  const symbols = (arg("--symbols") ?? "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const timeframes = (arg("--timeframes") ?? "1h,4h,1d")
    .split(",").map((s) => s.trim()).filter(isTimeframe) as Timeframe[];

  console.log(`\n${BOLD}مقارنة مؤشّراتنا مع TradingView${RESET}`);
  console.log(`${DIM}المنصّة: ${cfg.MARKET_EXCHANGE} · كل القيم محسوبة على شموع مغلقة فقط${RESET}\n`);

  const problems: string[] = [];

  for (const symbol of symbols) {
    console.log(`${BOLD}${symbol}${RESET}`);

    for (const tf of timeframes) {
      const r = await source.klines({ symbol, timeframe: tf, limit: BARS });
      if (!r.available) {
        console.log(`  ${tf.padEnd(4)} ${AMBER}تعذّر الجلب:${RESET} ${r.detail ?? r.reason}`);
        problems.push(`${symbol} ${tf}: ${r.detail ?? r.reason}`);
        continue;
      }

      const now = Date.now();
      const closed = dropUnclosed(r.value, tf, now);
      const dropped = r.value.length - closed.length;

      if (closed.length < 200) {
        console.log(`  ${tf.padEnd(4)} ${AMBER}تاريخ غير كافٍ:${RESET} ${closed.length} شمعة فقط، والمتوسط 200 يحتاج 200`);
        problems.push(`${symbol} ${tf}: تاريخ غير كافٍ`);
        continue;
      }

      const closes = closed.map((c) => c.close);
      const rsiSeries = rsi(closes, 14);
      const smaSeries = sma(closes, 200);
      const emaSeries = ema(closes, 200);

      const last = closed.length - 1;
      const prev = last - 1;

      const row = (i: number, label: string) => {
        const c = closed[i];
        const when = new Date(c.openTime).toISOString().replace("T", " ").slice(0, 16);
        console.log(
          `  ${tf.padEnd(4)} ${label.padEnd(10)} ${DIM}${when} UTC${RESET}  ` +
            `إغلاق ${fmtPrice(c.close).padStart(13)}  ·  ` +
            `RSI(14) ${rsiSeries[i].toFixed(2).padStart(6)}  ·  ` +
            `SMA(200) ${fmtPrice(smaSeries[i]).padStart(13)}  ·  ` +
            `EMA(200) ${fmtPrice(emaSeries[i]).padStart(13)}`,
        );
      };

      row(last, "آخر مغلقة");
      row(prev, "التي قبلها");
      if (dropped > 0) {
        console.log(`       ${DIM}حُذفت ${dropped} شمعة جارية قبل الحساب${RESET}`);
      }
    }
    console.log("");
  }

  console.log(`${BOLD}كيف تتحقّق${RESET}`);
  console.log(`  1. افتح TradingView على نفس الزوج ونفس المنصّة (${cfg.MARKET_EXCHANGE.toUpperCase()}) ونفس الإطار.`);
  console.log(`  2. أضف: RSI بطول 14، وMoving Average بطول 200 نوع SMA، وآخر نوع EMA.`);
  console.log(`  3. ${AMBER}مهم:${RESET} اضبط المنطقة الزمنية في TradingView على UTC.`);
  console.log(`     ${DIM}(أسفل يمين الشارت ← الساعة ← UTC)${RESET}`);
  console.log(`  4. ${AMBER}الأهم:${RESET} الشمعة الأخيرة في TradingView ما زالت مفتوحة وقيمها تتحرّك كل ثانية.`);
  console.log(`     قارن مع الشمعة المغلقة صاحبة الوقت المطبوع أعلاه — ضع المؤشّر عليها واقرأ القيمة.`);
  console.log(`  5. ${DIM}TradingView يستخدم SMA كنوع افتراضي لمؤشّر MA. طبعنا الاثنين لتقارن أيّهما تستخدم.${RESET}`);
  console.log(`\n${BOLD}الفرق المقبول${RESET}`);
  console.log(`  RSI: أقل من 0.05 نقطة · المتوسطات: أقل من 0.01% من السعر.`);
  console.log(`  ${DIM}فرق أكبر من ذلك يعني اختلافاً حقيقياً في التعريف، لا تقريباً — أبلغني به.${RESET}`);

  if (problems.length) {
    console.log(`\n${AMBER}تعذّر حساب ${problems.length} حالة:${RESET}`);
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error("فشل:", err);
  process.exit(1);
});
