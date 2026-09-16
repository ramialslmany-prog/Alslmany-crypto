/**
 * Stage 7 — sentiment, news and risk.
 *
 * ITS ROLE IS PREVENTIVE. It does not find trades; it stops trades that are
 * technically correct and wrong on timing. So its score is capped in the
 * positive direction and uncapped in the negative: good news is never a
 * reason to buy, while severe bad news is a reason not to.
 *
 * Fear & Greed is read CONTRARIAN, which is the only way it carries
 * information: extreme fear is when the technical setups are cheapest, and
 * extreme greed is when the crowd most agrees with you.
 */
import { aggregateNews, classifyNews, type AssetIdentity, type ClassifiedNews, type NewsAggregate } from "@/core/sentiment/classify";
import { checkCalendar, newsVeto, type CalendarCheck, type CalendarEvent } from "@/core/sentiment/calendar";
import { stageFail, stagePass, stageUnavailable, type StageResult } from "@/core/pipeline/types";
import { percentileRank } from "@/core/indicators/series";
import type { Factor } from "@/core/analysis/types";
import type { Direction, FearGreed } from "@/core/types";
import { type Availability, isAvailable } from "@/shared/availability";
import type { NewsItem } from "@/data/news/rss";

export interface SentimentInput {
  readonly asset: AssetIdentity;
  readonly direction: Direction;
  readonly fearGreed: Availability<FearGreed>;
  /** History for placing today's reading in its own range. */
  readonly fearGreedHistory: Availability<readonly FearGreed[]>;
  readonly news: Availability<readonly NewsItem[]>;
  /** Null means no calendar file — reported as unchecked, not as clear. */
  readonly calendar: readonly CalendarEvent[] | null;
  /** Social sentiment, when a provider key exists. */
  readonly social: Availability<{ score: number | null; socialVolumeChangePct: number | null }>;
  readonly now: number;
}

export interface SentimentResult extends StageResult {
  readonly news: NewsAggregate | null;
  readonly calendarCheck: CalendarCheck;
  readonly fearGreedValue: number | null;
}

const WEIGHTS = {
  fearGreed: 30,
  news: 45,
  social: 25,
} as const;

/** Good news cannot push this stage far positive — it is a brake, not a motor. */
const POSITIVE_CAP = 35;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const fmt = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : "—");

export function runSentiment(input: SentimentInput): SentimentResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];

  // ── fear and greed, contrarian ───────────────────────────────────────────
  let fearGreedValue: number | null = null;
  if (isAvailable(input.fearGreed)) {
    const fg = input.fearGreed.value;
    fearGreedValue = fg.value;

    // Where today sits in its OWN recent range, not against a fixed 0-100:
    // a market that has spent a year between 40 and 60 treats 65 as greed.
    const history = isAvailable(input.fearGreedHistory)
      ? input.fearGreedHistory.value.map((f) => f.value)
      : [];
    const percentile = history.length >= 30 ? percentileRank(history, fg.value) : null;

    // Contrarian: fear favours longs, greed favours caution on longs.
    const contrarian = (50 - fg.value) / 50;
    const normalized = clamp(contrarian * (input.direction === "long" ? 1 : -1), -1, 1);

    factors.push({
      id: "fear_greed",
      label: "مؤشر الخوف والطمع",
      value: fg.value,
      display: `${fg.value} (${fg.classification})${percentile != null ? ` · المئوي ${fmt(percentile * 100, 0)}` : ""}`,
      contribution: normalized * WEIGHTS.fearGreed,
      note:
        (fg.value <= 25
          ? "خوف شديد — يُقرأ معاكساً: هنا تكون الإعدادات الفنية أرخص، ويرتفع وزن إشارات الشراء."
          : fg.value >= 75
            ? "طمع شديد — يُقرأ معاكساً: الحشد يوافقك، وهذا أسوأ وقت للانضمام إليه."
            : "لا تطرّف في مشاعر السوق.") +
        (percentile == null
          ? " (التاريخ أقل من 30 قراءة، فلا يمكن وضع الرقم في مداه الخاص.)"
          : ""),
    });
  } else {
    missing.push("الخوف والطمع");
  }

  // ── news ─────────────────────────────────────────────────────────────────
  let news: NewsAggregate | null = null;
  let classified: ClassifiedNews[] = [];

  if (isAvailable(input.news)) {
    classified = input.news.value.map((item) => classifyNews(item, input.asset));
    news = aggregateNews(classified);

    // Negative news counts against BOTH directions: bad news on a coin is a
    // reason to stay out, not a reason to short it. Shorting a collapse after
    // the headline is how a bot buys the bottom of the panic from someone else.
    const normalized = clamp(news.netSentiment, -1, 1) * (input.direction === "long" ? 1 : 0.4);

    factors.push({
      id: "news",
      label: "الأخبار (48 ساعة)",
      value: news.netSentiment,
      display: `${news.items.length} ذات صلة · ${news.positiveCount}+ / ${news.negativeCount}−`,
      contribution: normalized * WEIGHTS.news,
      note: news.arabic,
    });

    if (news.worstNegative && news.worstNegative.intensity >= 0.5) {
      warnings.push(`خبر سلبي قوي: ${news.worstNegative.title.slice(0, 80)}`);
    }
  } else {
    missing.push("الأخبار");
    factors.push({
      id: "news", label: "الأخبار (48 ساعة)", value: null, display: "غير متاحة",
      contribution: 0,
      note: `تعذّر قراءة مصادر الأخبار — ${input.news.detail ?? input.news.reason}. لا يمكن التحقّق من فلتر الخبر السلبي.`,
    });
  }

  // ── social, when a provider exists ───────────────────────────────────────
  if (isAvailable(input.social)) {
    const s = input.social.value;
    // A mention spike is a CROWDING warning, not a reason to join.
    const spike = s.socialVolumeChangePct ?? 0;
    const normalized = spike > 100 ? -0.6 : spike > 50 ? -0.3 : 0;
    factors.push({
      id: "social", label: "المشاعر الاجتماعية", value: s.score,
      display: s.score != null ? `الدرجة ${fmt(s.score, 0)} · الحجم ${fmt(spike, 0)}%` : "—",
      contribution: normalized * WEIGHTS.social,
      note: spike > 50
        ? `ارتفاع الذكر ${fmt(spike, 0)}% — ازدحام، لا تأكيد. القمم الاجتماعية تسبق الانعكاسات لا الاستمرار.`
        : "لا ارتفاع لافت في الذكر الاجتماعي.",
    });
  } else {
    missing.push("المشاعر الاجتماعية");
  }

  // ── the hard vetoes ──────────────────────────────────────────────────────
  const calendarCheck = checkCalendar(input.calendar, input.asset, input.direction, input.now);
  const severeNews = newsVeto(news?.worstNegative ?? null, input.now);

  factors.push({
    id: "risk_calendar",
    label: "تقويم المخاطر",
    value: calendarCheck.available ? calendarCheck.vetoes.length : null,
    display: calendarCheck.available
      ? calendarCheck.vetoes.length > 0 ? `${calendarCheck.vetoes.length} نقض` : "خالٍ"
      : "غير متاح",
    contribution: 0,
    note: calendarCheck.arabic,
  });

  if (!calendarCheck.available) {
    missing.push("تقويم المخاطر");
    warnings.push("تقويم المخاطر غير مضبوط — فلتر الحدث الاقتصادي وفلتر فتح التوكنات لم يُفحصا");
  }

  const rawScore = factors.reduce((s, f) => s + f.contribution, 0);
  // Asymmetric on purpose: this stage brakes, it does not accelerate.
  const score = clamp(rawScore, -100, POSITIVE_CAP);
  const bias = score > 15 ? "bullish" : score < -15 ? "bearish" : "neutral";

  const arabic = [
    `المشاعر والأخبار والمخاطر (${input.asset.ticker}): النتيجة ${fmt(score, 0)}.`,
    factors.find((f) => f.id === "fear_greed")?.note ?? "",
    news?.arabic ?? "",
    calendarCheck.arabic,
    severeNews.arabic,
    rawScore > POSITIVE_CAP
      ? `النتيجة الخام ${fmt(rawScore, 0)} حُدَّت عند ${POSITIVE_CAP} — الأخبار الجيدة ليست سبباً للشراء، ودورها وقائي فقط.`
      : "",
    missing.length > 0 ? `غير متاح: ${missing.join("، ")}.` : "",
  ].filter(Boolean).join(" ");

  const base = { news, calendarCheck, fearGreedValue };

  // ── vetoes fail the stage outright ───────────────────────────────────────
  const allVetoes = [
    ...calendarCheck.vetoes.map((v) => v.arabic),
    ...(severeNews.veto ? [severeNews.arabic] : []),
  ];

  if (allVetoes.length > 0) {
    return {
      ...stageFail("sentiment", allVetoes.join(" · "), {
        score, bias, factors, warnings, arabic, durationMs: Date.now() - started,
      }),
      ...base,
    };
  }

  // Nothing readable at all: the preventive filters could not run.
  if (missing.length >= 3) {
    return {
      ...stageUnavailable("sentiment", `تعذّر قراءة: ${missing.join("، ")}`, 0.15, {
        factors, warnings, durationMs: Date.now() - started,
      }),
      ...base,
    };
  }

  return {
    ...stagePass("sentiment", {
      score, bias, factors,
      // Each missing input costs a declared share.
      confidencePenalty: Math.min(0.3, missing.length * 0.08),
      warnings, arabic,
      dataAgeMs: isAvailable(input.fearGreed) ? input.now - input.fearGreed.asOf : null,
      durationMs: Date.now() - started,
    }),
    ...base,
  };
}
