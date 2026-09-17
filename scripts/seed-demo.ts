/**
 * Seed a demonstration database.
 *
 *   npx tsx scripts/seed-demo.ts
 *
 * For verifying the site renders real content, and for looking at the pages
 * before the worker has run anywhere. Everything it writes goes through the
 * SAME repositories and the SAME immutable tables the bot uses — a seeder
 * with its own insert statements would let the site be verified against
 * shapes the real pipeline never produces.
 *
 * Writes to data/demo.db unless DB_FILE says otherwise, so it cannot
 * overwrite a real run.
 */
import crypto from "node:crypto";
import { openDb, closeDb } from "@/storage/db";
import { CandleRepo } from "@/storage/repositories/candles";
import { SymbolRepo } from "@/storage/repositories/symbols";
import { HealthRepo } from "@/storage/repositories/health";
import { RecommendationRepo, RejectedRepo } from "@/storage/repositories/recommendations";
import { PositionRepo, EquityRepo } from "@/storage/repositories/positions";
import { openPending } from "@/core/execution/paper-broker";
import { computeIntegrityHash, recommendationId } from "@/core/recommendation/builder";
import { available, unavailable } from "@/shared/availability";
import { tfMillis, type Timeframe } from "@/shared/time";
import type { Candle, SymbolInfo } from "@/core/types";
import type { Recommendation } from "@/core/recommendation/types";
import type { PipelineRun } from "@/core/pipeline/types";
import path from "node:path";

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

/** Deterministic, so two runs produce the same database. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candles(symbol: string, tf: Timeframe, count: number, start: number, seed: number): Candle[] {
  const rand = rng(seed);
  const step = tfMillis(tf);
  const out: Candle[] = [];
  let p = start;
  const from = NOW - count * step;

  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 40) * 0.003 + 0.0004;
    const r = drift + (rand() - 0.5) * 0.012;
    const open = p;
    const close = open * (1 + r);
    const wick = Math.abs(r) * open * 0.7 + open * 0.0006;
    const volume = 400 + Math.abs(r) * 60_000 + rand() * 200;
    out.push({
      openTime: from + i * step,
      closeTime: from + (i + 1) * step,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume,
      quoteVolume: volume * close,
      trades: Math.round(50 + rand() * 300),
      takerBuyBase: volume * (0.42 + rand() * 0.18),
      takerBuyQuote: 0,
    });
    p = close;
  }
  return out;
}

const UNIVERSE: { symbol: string; base: string; price: number; seed: number }[] = [
  { symbol: "BTCUSDT", base: "BTC", price: 61_000, seed: 11 },
  { symbol: "ETHUSDT", base: "ETH", price: 3_400, seed: 22 },
  { symbol: "SOLUSDT", base: "SOL", price: 138, seed: 33 },
  { symbol: "LINKUSDT", base: "LINK", price: 21.4, seed: 44 },
  { symbol: "AVAXUSDT", base: "AVAX", price: 39.8, seed: 55 },
  { symbol: "ADAUSDT", base: "ADA", price: 0.86, seed: 66 },
];

const emptyRun = (symbol: string, tf: Timeframe): PipelineRun => ({
  symbol, tradingTimeframe: tf, startedAt: NOW, finishedAt: NOW,
  stages: [
    stage(1, "eligibility", "فلتر الأهلية", "pass", 0,
      `${symbol} اجتازت فلتر الأهلية. الحجم 412 مليون، الفارق 1.4 نقطة أساس، عمق 180 ألف ضمن 1%، ومدرجة منذ 1,840 يوم.`),
    stage(2, "macro", "السياق الكلي", "pass", 38,
      "البيتكوين صاعد على اليومي (فوق المتوسط 50، فوق المتوسط 200، ADX 27) وعلى الأربع ساعات صاعد. هيمنة البيتكوين 54.20%. الاتجاه المسموح في هذه الدورة: الشراء والبيع."),
    stage(3, "technical", "التحليل الفني", "pass", 52,
      "قراءة الأطر — 1h: صاعد (41) · 4h: صاعد (58) · 1d: صاعد (46). درجة الاتفاق 71 من 100. إطار التداول 4h وإطاره المرجعي 1d صاعد. لا تعارض بين أي إطارين. النتيجة: تمرّ إلى المرحلة التالية."),
    stage(4, "structure", "الهيكل والمستويات والأنماط", "pass", 44,
      "الهيكل: قمم أعلى وقيعان أعلى، و3 تأرجحات متتالية تؤكّده. اكتُشف 9 مستويات مرتّبة بقوّتها. آخر حدث هيكلي: كسر لقمة بإغلاق — كسر هيكلي مؤكّد في اتجاه الهيكل، استمرار."),
    unavailableStage(5, "flows", "التدفّقات والمشتقّات", 0.20, "مرحلة التدفّقات والمشتقّات لم تُبنَ بعد"),
    unavailableStage(6, "onchain", "بيانات السلسلة", 0.15, "لا مزوّد لبيانات السلسلة — ضع CRYPTOQUANT_API_KEY"),
    unavailableStage(7, "sentiment", "المشاعر والأخبار والمخاطر", 0.10, "مرحلة المشاعر والأخبار لم تُبنَ بعد"),
    stage(8, "council", "المجلس النهائي", "pass", 64,
      "النظام السوقي: اتجاه صاعد — ADX 28.4، والهيكل يوافق. مؤشرات الانعكاس مُلغاة تماماً في هذا النظام. نمط الصفقة: استمرار اتجاه بعد ارتداد (شراء) — مطابقة 85%. 3 مراحل غير متاحة، وقد خُفضت الثقة بنسبة معلومة بسببها. لم يُفعَّل أي فلتر نقض — تُبنى خطة الصفقة الآن."),
  ],
  failedAt: null, regime: "trending_up", setup: null, vetoes: [],
  finalScore: 64, confidence: 61, recommendationId: null, arabic: "",
});

function stage(n: number, id: string, name: string, status: "pass" | "fail", score: number, arabic: string) {
  return {
    id: id as never, number: n, name, status, score,
    bias: (score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral") as never,
    factors: [], failReason: null, unavailableReason: null,
    confidencePenalty: 0, warnings: [], arabic, dataAgeMs: null, durationMs: 12,
  };
}

function unavailableStage(n: number, id: string, name: string, penalty: number, reason: string) {
  return {
    id: id as never, number: n, name, status: "unavailable" as const, score: 0,
    bias: "neutral" as never, factors: [], failReason: null, unavailableReason: reason,
    confidencePenalty: penalty, warnings: [],
    arabic: `${name}: غير متاحة — ${reason}. خُفضت الثقة الكلية بنسبة ${Math.round(penalty * 100)}%.`,
    dataAgeMs: null, durationMs: 0,
  };
}

function main(): void {
  const dbPath = path.resolve("./data", process.env.DB_FILE ?? "demo.db");
  const db = openDb(dbPath);

  const candleRepo = new CandleRepo(db);
  const symbolRepo = new SymbolRepo(db);
  const healthRepo = new HealthRepo(db);
  const recRepo = new RecommendationRepo(db);
  const rejectRepo = new RejectedRepo(db);
  const posRepo = new PositionRepo(db);
  const equityRepo = new EquityRepo(db);

  // ── universe and candles ─────────────────────────────────────────────────
  const infos: SymbolInfo[] = UNIVERSE.map((u) => ({
    symbol: u.symbol, nativeSymbol: u.symbol, base: u.base, quote: "USDT",
    market: "spot", status: "trading", pricePrecision: u.price > 100 ? 2 : 4,
    quantityPrecision: 5, minNotional: 5,
    listedAt: NOW - (900 + u.seed * 8) * 86_400_000,
  }));
  symbolRepo.upsertMany("binance", infos);

  const series = new Map<string, Candle[]>();
  for (const u of UNIVERSE) {
    for (const tf of ["1h", "4h", "1d"] as Timeframe[]) {
      const bars = candles(u.symbol, tf, tf === "1h" ? 700 : tf === "4h" ? 420 : 300, u.price, u.seed + tf.length);
      candleRepo.upsertMany(u.symbol, tf, bars, "archive");
      series.set(`${u.symbol}:${tf}`, bars);
    }
  }

  // ── health ───────────────────────────────────────────────────────────────
  healthRepo.record("binance:klines", "بايننس — الشموع", available(null, "binance", NOW), { latencyMs: 84 });
  healthRepo.record("binance:symbols", "بايننس — قائمة العملات", available(null, "binance", NOW), { latencyMs: 210 });
  healthRepo.record("coingecko:global", "CoinGecko — السوق الكلّي", available(null, "cg", NOW), { latencyMs: 340 });
  healthRepo.record("alternative.me:fng", "مؤشر الخوف والطمع", available(null, "fng", NOW), { latencyMs: 190 });
  healthRepo.record("cryptoquant", "CryptoQuant — بيانات السلسلة",
    unavailable("cryptoquant", "not_configured", "ضع CRYPTOQUANT_API_KEY"), { enabled: false });
  healthRepo.record("coinglass", "Coinglass — مشتقّات مجمّعة",
    unavailable("coinglass", "not_configured", "ضع COINGLASS_API_KEY"), { enabled: false });

  // ── recommendations, positions, events ───────────────────────────────────
  const scenarios: {
    symbol: string; tf: Timeframe; direction: "long" | "short"; setup: string;
    confidence: number; outcome: "win2" | "win1" | "loss" | "open" | "pending";
    ageHours: number;
  }[] = [
    { symbol: "SOLUSDT", tf: "4h", direction: "long", setup: "trend_continuation", confidence: 74, outcome: "win2", ageHours: 300 },
    { symbol: "ETHUSDT", tf: "1h", direction: "long", setup: "breakout_retest", confidence: 68, outcome: "win1", ageHours: 240 },
    { symbol: "LINKUSDT", tf: "4h", direction: "short", setup: "range_reversal", confidence: 55, outcome: "loss", ageHours: 200 },
    { symbol: "AVAXUSDT", tf: "1h", direction: "long", setup: "momentum_ignition", confidence: 71, outcome: "win2", ageHours: 160 },
    { symbol: "ADAUSDT", tf: "1d", direction: "long", setup: "trend_continuation", confidence: 49, outcome: "loss", ageHours: 130 },
    { symbol: "BTCUSDT", tf: "4h", direction: "long", setup: "liquidity_sweep", confidence: 66, outcome: "win1", ageHours: 96 },
    { symbol: "ETHUSDT", tf: "4h", direction: "short", setup: "divergence_reversal", confidence: 52, outcome: "loss", ageHours: 72 },
    { symbol: "SOLUSDT", tf: "1h", direction: "long", setup: "trend_continuation", confidence: 63, outcome: "open", ageHours: 18 },
    { symbol: "BTCUSDT", tf: "1h", direction: "long", setup: "breakout_retest", confidence: 58, outcome: "pending", ageHours: 3 },
  ];

  let equity = 10_000;
  let peak = 10_000;
  const curve: { at: number; equity: number; peak: number; btc: number }[] = [];
  const btcBars = series.get("BTCUSDT:1h") ?? [];

  for (const s of scenarios) {
    const at = NOW - s.ageHours * HOUR;
    const bars = series.get(`${s.symbol}:${s.tf}`) ?? [];
    const bar = bars.find((b) => b.openTime >= at) ?? bars[bars.length - 1];
    if (!bar) continue;

    const long = s.direction === "long";
    const entry = bar.close;
    const risk = entry * 0.035;
    const stop = long ? entry - risk : entry + risk;
    const mk = (r: number) => (long ? entry + risk * r : entry - risk * r);

    const targets = [
      { index: 1 as const, price: mk(1.9), closeFraction: 0.5, rMultiple: 1.9, basis: "منطقة مقاومة بقوّة 68، اختُبرت 4 مرات" },
      { index: 2 as const, price: mk(3.4), closeFraction: 0.3, rMultiple: 3.4, basis: "منطقة مقاومة بقوّة 61، اختُبرت 3 مرات" },
      { index: 3 as const, price: mk(5.2), closeFraction: 0.2, rMultiple: 5.2, basis: "قمة الشهر السابق" },
    ];

    const id = recommendationId(s.symbol, s.tf, bar.openTime);
    const draft: Omit<Recommendation, "integrityHash"> = {
      id, symbol: s.symbol, direction: s.direction, setup: s.setup as never,
      regime: "trending_up", timeframe: s.tf, generatedAt: at, asOfCandle: bar.openTime,
      exchange: "binance",
      entry: { low: entry * 0.997, high: entry * 1.003, mid: entry },
      stop, stopBasis: `خلف آخر قاع هيكلي مؤكّد مع هامش تقلّب 0.35 من ATR`,
      targets: targets as never,
      riskReward: 5.2,
      expectedR: 1.9 * 0.5 + 3.4 * 0.3 + 5.2 * 0.2,
      positionSize: 100 / risk, positionNotional: (100 / risk) * entry,
      riskAmount: 100, riskPercent: 1,
      confidence: s.confidence,
      confidenceComponents: [
        { stage: "macro", name: "السياق الكلي", score: 38, weight: 0, contribution: 0, status: "pass", note: "" },
        { stage: "technical", name: "التحليل الفني", score: 52, weight: 0.32, contribution: 17, status: "pass", note: "" },
        { stage: "structure", name: "الهيكل والمستويات", score: 44, weight: 0.34, contribution: 15, status: "pass", note: "" },
        { stage: "flows", name: "التدفّقات", score: 0, weight: 0.19, contribution: 0, status: "unavailable", note: "" },
        { stage: "onchain", name: "بيانات السلسلة", score: 0, weight: 0.10, contribution: 0, status: "unavailable", note: "" },
        { stage: "sentiment", name: "المشاعر", score: 0, weight: 0.05, contribution: 0, status: "unavailable", note: "" },
      ],
      finalScore: 60 + (s.confidence - 55) * 0.4,
      invalidation: [
        { id: "stop_hit", subject: "close", operator: long ? "lte" : "gte", value: stop,
          arabic: `إغلاق شمعة ${long ? "تحت" : "فوق"} الوقف ${stop.toFixed(4)} — خروج فوري` },
        { id: "structure_flip", subject: "structure_state", operator: "eq", value: long ? "downtrend" : "uptrend",
          arabic: `انقلاب الهيكل — فكرة الصفقة لم تعد قائمة` },
        { id: "expiry", subject: "elapsed_bars", operator: "gte", value: 12,
          arabic: "مرور 12 شمعة دون وصول السعر لمنطقة الدخول — انتهاء صلاحية" },
      ] as never,
      expiresAt: at + 12 * tfMillis(s.tf),
      report: buildReport(s.symbol, s.direction, entry, stop, targets, s.confidence),
    };

    const rec: Recommendation = { ...draft, integrityHash: computeIntegrityHash(draft) };
    recRepo.create(rec, emptyRun(s.symbol, s.tf));

    // ── the position and its events ──────────────────────────────────────
    if (s.outcome === "pending") {
      posRepo.save(openPending({
        id: `pos-${id}`, recommendationId: id, symbol: s.symbol, direction: s.direction,
        timeframe: s.tf, entry: rec.entry, stop, targets: targets as never,
        size: rec.positionSize, risk: 100, expiresAt: rec.expiresAt,
      }));
      continue;
    }

    const entryAt = at + tfMillis(s.tf);
    recRepo.appendEvent({
      recommendationId: id, kind: "entry_filled", at: entryAt, candleTime: bar.openTime,
      price: entry, payload: {},
      arabic: `نُفّذ الدخول على فتح الشمعة التالية عند ${entry.toFixed(4)} (انزلاق 2.1 نقطة أساس، رسوم ${(rec.positionNotional * 0.001).toFixed(4)}).`,
    });

    let realizedR = 0;
    let exitReason = "";
    let barsHeld = 0;

    if (s.outcome === "loss") {
      realizedR = -1.06;
      exitReason = "stop_loss";
      barsHeld = 9;
      recRepo.appendEvent({
        recommendationId: id, kind: "stop_hit", at: entryAt + 9 * tfMillis(s.tf),
        candleTime: bar.openTime, price: stop, payload: {},
        arabic: `أُغلق المركز — ضرب الوقف عند ${stop.toFixed(4)} بنتيجة ${(-100 * 1.06).toFixed(2)}.`,
      });
    } else {
      const hits = s.outcome === "win2" ? 2 : 1;
      for (let t = 0; t < hits; t++) {
        recRepo.appendEvent({
          recommendationId: id, kind: "target_hit", at: entryAt + (t + 3) * tfMillis(s.tf),
          candleTime: bar.openTime, price: targets[t].price, payload: { target: t + 1 },
          arabic: `بلغ الهدف ${t + 1} عند ${targets[t].price.toFixed(4)} — خروج جزئي بـ${Math.round(targets[t].closeFraction * 100)}% من المركز.`,
        });
        if (t === 0) {
          recRepo.appendEvent({
            recommendationId: id, kind: "stop_moved", at: entryAt + 3 * tfMillis(s.tf),
            candleTime: bar.openTime, price: entry, payload: { breakeven: true },
            arabic: `نُقل الوقف إلى ${entry.toFixed(4)} — بلوغ الهدف الأول، فلم يعد المركز قادراً على الخسارة.`,
          });
        }
      }
      realizedR = hits === 2 ? 2.31 : 0.94;
      exitReason = hits === 2 ? "trailing_stop" : "breakeven_stop";
      barsHeld = hits === 2 ? 22 : 14;
      recRepo.appendEvent({
        recommendationId: id, kind: "closed", at: entryAt + barsHeld * tfMillis(s.tf),
        candleTime: bar.openTime, price: hits === 2 ? targets[1].price : entry, payload: {},
        arabic: `أُغلق المركز — ${hits === 2 ? "الوقف المتتبّع" : "وقف التعادل"} بنتيجة ${(realizedR * 100).toFixed(2)}.`,
      });
    }

    if (s.outcome !== "open") {
      const closedAt = entryAt + barsHeld * tfMillis(s.tf);
      const base = openPending({
        id: `pos-${id}`, recommendationId: id, symbol: s.symbol, direction: s.direction,
        timeframe: s.tf, entry: rec.entry, stop, targets: targets as never,
        size: rec.positionSize, risk: 100, expiresAt: rec.expiresAt,
      });
      posRepo.save({
        ...base, status: "closed", openedAt: entryAt, closedAt,
        exitReason: exitReason as never, averageEntry: entry, openQuantity: 0,
        targetsHit: s.outcome === "win2" ? [1, 2] : s.outcome === "win1" ? [1] : [],
        realizedPnl: realizedR * 100, realizedR,
        maxFavorableR: realizedR > 0 ? realizedR + 0.5 : 0.7,
        maxAdverseR: realizedR > 0 ? -0.35 : -1.06,
        barsHeld,
      });

      equity += realizedR * 100;
      peak = Math.max(peak, equity);
      const btcAt = btcBars.find((b) => b.openTime >= closedAt)?.close ?? btcBars[btcBars.length - 1]?.close ?? 61_000;
      curve.push({ at: closedAt, equity, peak, btc: btcAt });
    } else {
      const base = openPending({
        id: `pos-${id}`, recommendationId: id, symbol: s.symbol, direction: s.direction,
        timeframe: s.tf, entry: rec.entry, stop, targets: targets as never,
        size: rec.positionSize, risk: 100, expiresAt: rec.expiresAt,
      });
      posRepo.save({ ...base, status: "open", openedAt: entryAt, averageEntry: entry, openQuantity: rec.positionSize });
    }
  }

  // ── the equity curve ─────────────────────────────────────────────────────
  const start = NOW - 320 * HOUR;
  const startBtc = btcBars[0]?.close ?? 61_000;
  equityRepo.record({
    at: start, equity: 10_000, cash: 10_000, openPositions: 0, exposureNotional: 0,
    peakEquity: 10_000, drawdownPct: 0, dayStartEquity: 10_000, dayPnlPct: 0,
  }, startBtc);

  for (const c of curve.sort((a, b) => a.at - b.at)) {
    equityRepo.record({
      at: c.at, equity: c.equity, cash: c.equity, openPositions: 0, exposureNotional: 0,
      peakEquity: c.peak, drawdownPct: ((c.peak - c.equity) / c.peak) * 100,
      dayStartEquity: c.equity, dayPnlPct: 0,
    }, c.btc);
  }

  const lastBtc = btcBars[btcBars.length - 1]?.close ?? 61_000;
  equityRepo.record({
    at: NOW, equity, cash: equity * 0.7, openPositions: 1, exposureNotional: equity * 0.3,
    peakEquity: peak, drawdownPct: ((peak - equity) / peak) * 100,
    dayStartEquity: equity * 0.995, dayPnlPct: 0.5,
  }, lastBtc);

  // ── rejections: the majority of what the bot does ────────────────────────
  const rejections: [string, number, string, string][] = [
    ["PEPEUSDT", 1, "eligibility", "مدرجة منذ 41 يوم فقط، والحد الأدنى 90 يوماً"],
    ["WIFUSDT", 1, "eligibility", "حجم التداول 2.10 مليون، والحد الأدنى 5.0 مليون"],
    ["BONKUSDT", 1, "eligibility", "الفارق 38.4 نقطة أساس، والحد الأقصى 25"],
    ["XRPUSDT", 3, "technical", "تعارض قاتل: 1h صاعد بينما 1d هابط — فارق مستويين، والصفقة تسقط"],
    ["DOTUSDT", 3, "technical", "درجة الاتفاق 22 من 100 — الأطر متشتّتة ولا اتجاه غالب"],
    ["ATOMUSDT", 4, "structure", "لم تُكتشف أي مستويات — لا يمكن تحديد وقف ولا هدف"],
    ["NEARUSDT", 8, "council", "لا ينطبق أي نمط صفقة بوضوح. نتيجة عالية بلا نمط واضح ليست فرصة."],
    ["FILUSDT", 8, "council", "النتيجة النهائية 47 دون الحد الأدنى 60"],
    ["APTUSDT", 8, "council", "العائد للمخاطرة 1.22 دون الحد الأدنى 1.8 — الأهداف عند المستويات الفعلية لا تبرّر مسافة الوقف"],
    ["INJUSDT", 8, "council", "3 مراكز مترابطة بأكثر من 0.8 في نفس الاتجاه — الحد 3"],
    ["SUIUSDT", 2, "macro", "السياق الكلي لا يسمح بأي اتجاه في هذه الدورة"],
    ["OPUSDT", 8, "council", "بيانات متأخرة في: التحليل الفني (214 دقيقة). الحد المسموح 2 شمعة."],
  ];

  for (let i = 0; i < 90; i++) {
    const [symbol, number, stageId, reason] = rejections[i % rejections.length];
    rejectRepo.record({
      symbol, tradingTimeframe: "4h", startedAt: NOW - i * HOUR, finishedAt: NOW - i * HOUR,
      stages: [{ id: stageId as never, number, name: stageId, status: "fail",
        score: 0, bias: "neutral", factors: [], failReason: reason, unavailableReason: null,
        confidencePenalty: 0, warnings: [], arabic: reason, dataAgeMs: null, durationMs: 5 }],
      failedAt: stageId as never, regime: null, setup: null, vetoes: [],
      finalScore: number === 8 ? 40 + (i % 20) : 0, confidence: 0,
      recommendationId: null, arabic: reason,
    }, reason);
  }

  const counts = {
    candles: candleRepo.count(),
    recommendations: recRepo.recent(500).length,
    rejected: rejectRepo.countSince(0),
    positions: posRepo.closed(500).length + posRepo.live().length,
  };

  closeDb();
  console.log(`seeded ${dbPath}`);
  console.log(`  candles         ${counts.candles.toLocaleString("en-US")}`);
  console.log(`  recommendations ${counts.recommendations}`);
  console.log(`  rejected        ${counts.rejected}`);
  console.log(`  positions       ${counts.positions}`);
  console.log(`  ratio           1 recommendation per ${(counts.rejected / Math.max(1, counts.recommendations)).toFixed(0)} analyses`);
  console.log(`\nDB_FILE=demo.db npm run dev`);
}

function buildReport(
  symbol: string, direction: "long" | "short", entry: number, stop: number,
  targets: { index: number; price: number; closeFraction: number }[], confidence: number,
): string {
  return [
    `تقرير التحليل الكامل — ${symbol}`,
    "",
    `المرحلة 1 — فلتر الأهلية (اجتازت): ${symbol} اجتازت فلتر الأهلية. الحجم 412 مليون، الفارق 1.4 نقطة أساس، عمق 180 ألف ضمن 1%.`,
    `المرحلة 2 — السياق الكلي (اجتازت): البيتكوين صاعد على اليومي وعلى الأربع ساعات. الاتجاه المسموح: الشراء والبيع.`,
    `المرحلة 3 — التحليل الفني (اجتازت): درجة الاتفاق 71 من 100، ولا تعارض بين أي إطارين.`,
    `المرحلة 4 — الهيكل والمستويات (اجتازت): قمم أعلى وقيعان أعلى، و3 تأرجحات متتالية تؤكّده.`,
    `المرحلة 5 — التدفّقات والمشتقّات (غير متاحة): لم تُبنَ بعد. خُفضت الثقة الكلية بنسبة 20%.`,
    `المرحلة 6 — بيانات السلسلة (غير متاحة): لا مزوّد. خُفضت الثقة الكلية بنسبة 15%.`,
    `المرحلة 7 — المشاعر والأخبار (غير متاحة): لم تُبنَ بعد. خُفضت الثقة الكلية بنسبة 10%.`,
    `المرحلة 8 — المجلس النهائي (اجتازت): النظام السوقي اتجاه صاعد، ومؤشرات الانعكاس مُلغاة تماماً فيه.`,
    "",
    "خطة الصفقة:",
    `منطقة الدخول بين ${(entry * 0.997).toFixed(4)} و${(entry * 1.003).toFixed(4)}. وهي نطاق مأخوذ من مستوى فعلي، لا سعر واحد، لأن السعر لا ينعكس عند نقطة بعينها.`,
    `الوقف عند ${stop.toFixed(4)} — خلف آخر قاع هيكلي مؤكّد مع هامش تقلّب 0.35 من ATR.`,
    ...targets.map((t) => `الهدف ${t.index} عند ${t.price.toFixed(4)} (${Math.round(t.closeFraction * 100)}% من المركز).`),
    "",
    `الخلاصة: الثقة ${confidence} من 100، بعد خفض 45% مجموعة من ثلاث مراحل غير متاحة.`,
  ].join("\n");
}

main();
