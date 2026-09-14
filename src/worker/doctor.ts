/**
 * `npm run doctor` — prove the data layer works against the REAL providers.
 *
 * Every check reports what it actually got: a price, a bar count, a latency.
 * A check that cannot run says why, in Arabic, and the exit code is non-zero
 * if anything essential failed — so this is usable in a deploy gate, not just
 * as something to read.
 *
 * This exists because unit tests prove the parsing is right; only this proves
 * the venue is reachable, the symbols are live, and the clocks agree.
 */
import { getConfig } from "@/shared/config";
import { createAllMarketSources, createMarketSource } from "@/data/exchanges";
import { FearGreedSource } from "@/data/macro/fear-greed";
import { DefiLlamaSource } from "@/data/macro/defillama";
import { CoinGeckoSource } from "@/data/macro/coingecko";
import { CryptoQuantProvider } from "@/data/premium/cryptoquant";
import { CoinglassProvider } from "@/data/premium/coinglass";
import { LunarCrushProvider } from "@/data/premium/lunarcrush";
import { BinanceVisionArchive } from "@/data/archive/binance-vision";
import { httpHealth } from "@/data/http";
import { openDb, closeDb } from "@/storage/db";
import { HealthRepo } from "@/storage/repositories/health";
import { CandleRepo } from "@/storage/repositories/candles";
import type { Availability } from "@/shared/availability";
import { REASON_AR } from "@/shared/availability";
import { dropUnclosed, lastClosedOpenTime, stalenessInBars } from "@/shared/time";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

type Severity = "essential" | "optional";

interface CheckResult {
  name: string;
  ok: boolean;
  severity: Severity;
  detail: string;
  ms: number;
}

const results: CheckResult[] = [];

async function check(
  name: string,
  severity: Severity,
  fn: () => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  const t0 = Date.now();
  let out: { ok: boolean; detail: string };
  try {
    out = await fn();
  } catch (err) {
    out = { ok: false, detail: `استثناء: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ms = Date.now() - t0;
  results.push({ name, ok: out.ok, severity, detail: out.detail, ms });

  const mark = out.ok ? `${GREEN}✔${RESET}` : severity === "essential" ? `${RED}✘${RESET}` : `${YELLOW}—${RESET}`;
  console.log(`${mark} ${name.padEnd(34)} ${DIM}${String(ms).padStart(5)}ms${RESET}  ${out.detail}`);
}

/** Turn an Availability into the doctor's ok/detail pair. */
function describe<T>(a: Availability<T>, onOk: (v: T, asOf: number) => string): { ok: boolean; detail: string } {
  if (a.available) return { ok: true, detail: onOk(a.value, a.asOf) };
  return { ok: false, detail: `${REASON_AR[a.reason]}${a.detail ? ` — ${a.detail}` : ""}` };
}

const fmt = (n: number, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

async function main(): Promise<void> {
  const cfg = getConfig();
  const probeSymbol = cfg.WATCHLIST[0] ?? `BTC${cfg.QUOTE_ASSET}`;

  console.log(`\n${BOLD}فحص مصادر البيانات — منصّة ${cfg.MARKET_EXCHANGE}${RESET}`);
  console.log(`${DIM}العملة المستخدمة للفحص: ${probeSymbol}${RESET}\n`);

  const src = createMarketSource(cfg);

  // ── venue ────────────────────────────────────────────────────────────────
  console.log(`${BOLD}المنصّة${RESET}`);

  await check("اتصال المنصّة وساعتها", "essential", async () => {
    const r = await src.serverTime();
    if (!r.available) return describe(r, () => "");
    const drift = Math.abs(Date.now() - r.value);
    // >5s of clock drift breaks signed requests and misclassifies bar closes.
    return {
      ok: drift < 5000,
      detail: `فارق الساعة ${drift}ms ${drift < 5000 ? "" : "— تجاوز الحدّ المسموح (5 ثوانٍ)"}`,
    };
  });

  await check("قائمة العملات", "essential", async () => {
    const r = await src.symbols("spot");
    return describe(r, (v) => {
      const trading = v.filter((s) => s.status === "trading").length;
      return `${v.length} زوج بعملة ${cfg.QUOTE_ASSET}، منها ${trading} قابل للتداول`;
    });
  });

  await check("لوحة الأسعار 24 ساعة", "essential", async () => {
    const r = await src.ticker24h([probeSymbol]);
    return describe(r, (v) => {
      const t = v[0];
      if (!t) return "لا بيانات للعملة المطلوبة";
      const spreadBps = ((t.askPrice - t.bidPrice) / t.lastPrice) * 10_000;
      return `السعر ${fmt(t.lastPrice)} · الفارق ${fmt(spreadBps, 2)} نقطة أساس · الحجم ${fmt(t.quoteVolume, 0)}`;
    });
  });

  for (const tf of ["1h", "1d"] as const) {
    await check(`شموع ${tf}`, "essential", async () => {
      const r = await src.klines({ symbol: probeSymbol, timeframe: tf, limit: 300 });
      if (!r.available) return describe(r, () => "");
      const now = Date.now();
      const closed = dropUnclosed(r.value, tf, now);
      const dropped = r.value.length - closed.length;
      const last = closed[closed.length - 1];
      if (!last) return { ok: false, detail: "لا توجد شمعة مغلقة" };
      const behind = stalenessInBars(last.openTime, tf, now);
      const expected = lastClosedOpenTime(now, tf);
      return {
        ok: behind <= 1,
        detail:
          `${closed.length} شمعة مغلقة · حُذفت ${dropped} جارية · ` +
          `آخر إغلاق ${new Date(last.openTime).toISOString().slice(0, 16)} ` +
          `(المتوقّع ${new Date(expected).toISOString().slice(0, 16)}، تأخّر ${behind} شمعة)`,
      };
    });
  }

  await check("دفتر الأوامر", "essential", async () => {
    const r = await src.orderBook(probeSymbol, 100);
    return describe(r, (v) => {
      const bidDepth = v.bids.reduce((s, l) => s + l.price * l.quantity, 0);
      const askDepth = v.asks.reduce((s, l) => s + l.price * l.quantity, 0);
      return `${v.bids.length} شراء / ${v.asks.length} بيع · عمق ${fmt(bidDepth, 0)} مقابل ${fmt(askDepth, 0)}`;
    });
  });

  await check("الصفقات المنفّذة", "essential", async () =>
    describe(await src.recentTrades(probeSymbol, 100), (v) => {
      const buys = v.filter((t) => !t.buyerIsMaker).length;
      return `${v.length} صفقة · ${buys} مبادرة شراء / ${v.length - buys} مبادرة بيع`;
    }),
  );

  // ── derivatives ──────────────────────────────────────────────────────────
  console.log(`\n${BOLD}المشتقّات${RESET}`);

  await check("معدّل التمويل", src.capabilities.funding ? "essential" : "optional", async () =>
    describe(await src.fundingRate(probeSymbol), (v) => `${fmt(v.rate * 100, 4)}% كل ${v.intervalHours} ساعات`),
  );

  await check("العقود المفتوحة", src.capabilities.openInterest ? "essential" : "optional", async () =>
    describe(await src.openInterestHistory(probeSymbol, "1h", 24), (v) => {
      const first = v[0]?.openInterest ?? NaN;
      const last = v[v.length - 1]?.openInterest ?? NaN;
      const chg = first > 0 ? ((last - first) / first) * 100 : NaN;
      return `${v.length} قراءة · التغيّر ${fmt(chg, 2)}% خلال النافذة`;
    }),
  );

  await check("نسبة الطويل للقصير", "optional", async () =>
    describe(await src.longShortRatio(probeSymbol, "1h", 10), (v) => {
      const last = v[v.length - 1];
      return last ? `${fmt(last.longAccountPct, 1)}% طويل مقابل ${fmt(last.shortAccountPct, 1)}% قصير` : "فارغ";
    }),
  );

  // ── archive ──────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}الأرشيف التاريخي${RESET}`);

  await check("data.binance.vision", src.capabilities.historicalArchive ? "essential" : "optional", async () => {
    const archive = new BinanceVisionArchive(cfg);
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 2); // two months back is certainly published
    const key = d.toISOString().slice(0, 7);
    const r = await archive.fetch(
      { symbol: `BTC${cfg.QUOTE_ASSET}`, dataType: "klines", timeframe: "1h", period: "monthly", periodKey: key, market: "spot" },
      { useCache: false },
    );
    if (!r.available) return describe(r, () => "");
    const bars = archive.parseKlineCsv(r.value.csv, "1h");
    const checksum =
      r.value.checksumOk === true ? "البصمة مطابقة" : r.value.checksumOk === false ? "البصمة غير مطابقة" : "تعذّر التحقّق من البصمة";
    return {
      ok: r.value.checksumOk !== false && bars.length > 0,
      detail: `${key}: ${bars.length} شمعة · ${fmt(r.value.bytes / 1024, 0)} كيلوبايت · ${checksum}`,
    };
  });

  // ── macro ────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}البيانات الكلّية${RESET}`);

  await check("مؤشر الخوف والطمع", "essential", async () =>
    describe(await new FearGreedSource(cfg).latest(), (v, asOf) => {
      const ageH = Math.round((Date.now() - asOf) / 3_600_000);
      return `${v.value} (${v.classification}) · عمر القراءة ${ageH} ساعة`;
    }),
  );

  await check("CoinGecko — السوق الكلّي", "essential", async () =>
    describe(await new CoinGeckoSource(cfg).global(), (v) =>
      `هيمنة البيتكوين ${fmt(v.btcDominance, 2)}% · القيمة السوقية ${fmt(v.totalMarketCap / 1e12, 3)} تريليون`,
    ),
  );

  await check("DefiLlama — القيمة المقفلة", "optional", async () =>
    describe(await new DefiLlamaSource(cfg).totalTvl(), (v) => `${fmt(v / 1e9, 2)} مليار دولار`),
  );

  // ── paid providers ───────────────────────────────────────────────────────
  console.log(`\n${BOLD}المصادر المدفوعة${RESET} ${DIM}(اختيارية — تعمل بوضع المفتاح)${RESET}`);

  const cq = new CryptoQuantProvider(cfg);
  const cg = new CoinglassProvider(cfg);
  const lc = new LunarCrushProvider(cfg);

  await check("CryptoQuant", "optional", async () =>
    cq.enabled
      ? describe(await cq.metrics("btc"), (v) => `صافي تدفّق المنصّات ${fmt(v.exchangeNetflow, 2)}`)
      : { ok: false, detail: cfg.providers.cryptoquant.note },
  );
  await check("Coinglass", "optional", async () =>
    cg.enabled
      ? describe(await cg.aggregated(probeSymbol), (v) => `العقود المفتوحة ${fmt(v.openInterestUsd / 1e9, 2)} مليار`)
      : { ok: false, detail: cfg.providers.coinglass.note },
  );
  await check("LunarCrush", "optional", async () =>
    lc.enabled
      ? describe(await lc.sentiment(probeSymbol), (v) => `الدرجة ${fmt(v.score ?? NaN, 1)}`)
      : { ok: false, detail: cfg.providers.lunarcrush.note },
  );

  // ── cross-venue price integrity ──────────────────────────────────────────
  console.log(`\n${BOLD}سلامة السعر عبر المنصّات${RESET}`);
  const prices: { venue: string; price: number }[] = [];
  for (const v of createAllMarketSources(cfg)) {
    const r = await v.ticker24h([probeSymbol]);
    if (r.available && r.value[0]) prices.push({ venue: v.label, price: r.value[0].lastPrice });
  }
  await check("تطابق الأسعار", "optional", async () => {
    if (prices.length < 2) return { ok: false, detail: `منصّة واحدة فقط استجابت — لا يمكن المقارنة` };
    const values = prices.map((p) => p.price);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const maxDev = Math.max(...values.map((v) => Math.abs(v - mean) / mean)) * 100;
    return {
      ok: maxDev < 1,
      detail: `${prices.map((p) => `${p.venue} ${fmt(p.price)}`).join(" · ")} — أقصى انحراف ${fmt(maxDev, 3)}%`,
    };
  });

  // ── storage ──────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}التخزين${RESET}`);
  await check("قاعدة البيانات", "essential", async () => {
    const db = openDb(cfg.dbPath);
    const repo = new CandleRepo(db);
    const health = new HealthRepo(db);
    for (const r of results) {
      health.record(
        r.name,
        r.name,
        r.ok
          ? { available: true, value: null, asOf: Date.now(), source: r.name }
          : { available: false, reason: "http_error", detail: r.detail, source: r.name },
        { latencyMs: r.ms },
      );
    }
    const mode = String(db.pragma("journal_mode", { simple: true }));
    return { ok: true, detail: `${cfg.dbPath} · وضع ${mode} · ${repo.count()} شمعة مخزّنة` };
  });

  // ── summary ──────────────────────────────────────────────────────────────
  const essentialFails = results.filter((r) => !r.ok && r.severity === "essential");
  const optionalFails = results.filter((r) => !r.ok && r.severity === "optional");
  const passed = results.filter((r) => r.ok).length;

  console.log(`\n${BOLD}الخلاصة${RESET}`);
  console.log(`  نجح ${passed} من ${results.length}`);
  if (essentialFails.length) {
    console.log(`  ${RED}فشل أساسي: ${essentialFails.length}${RESET}`);
    for (const f of essentialFails) console.log(`    ${RED}✘${RESET} ${f.name} — ${f.detail}`);
  }
  if (optionalFails.length) {
    console.log(`  ${YELLOW}غير متاح (اختياري): ${optionalFails.length}${RESET}`);
    for (const f of optionalFails) console.log(`    ${YELLOW}—${RESET} ${f.name} — ${f.detail}`);
  }

  const net = httpHealth();
  if (net.length) {
    console.log(`\n${BOLD}استهلاك حدود الطلبات${RESET}`);
    for (const h of net) {
      console.log(
        `  ${h.host.padEnd(28)} ${String(h.requests).padStart(4)} طلب · ` +
          `${String(h.failures).padStart(3)} فشل · ` +
          `زمن الاستجابة ${h.p95LatencyMs ?? "—"}ms · ` +
          `الحصة المستهلكة ${Math.round(h.utilization * 100)}%`,
      );
    }
  }

  closeDb();
  console.log("");
  process.exit(essentialFails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}فشل الفحص:${RESET}`, err);
  process.exit(1);
});
