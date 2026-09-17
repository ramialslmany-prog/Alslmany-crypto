/**
 * Stage 6 — on-chain.
 *
 * WHAT THIS STAGE CAN AND CANNOT SEE, stated before anything else, because
 * the gap between the two is where a reader would otherwise be misled.
 *
 * The spec's on-chain stage wants exchange netflows, whale accumulation and
 * miner behaviour. None of those have a free provider; CryptoQuant sells
 * them. What IS free is DefiLlama, and it answers a narrower question
 * honestly: how much capital is committed to this token's protocol, and how
 * much is committed to the sector as a whole.
 *
 * That is real information — TVL is capital somebody locked up, not a price
 * derivative — but it is NOT a substitute for netflows, and this stage never
 * pretends otherwise:
 *
 *  - For a DeFi token, protocol TVL and its trend are genuinely about that
 *    token's fundamentals.
 *  - For BITCOIN, protocol TVL is meaningless: Bitcoin has no protocol on
 *    DefiLlama. The stage says so and falls back to the market-wide reads
 *    rather than scoring noise.
 *  - Total DeFi TVL and stablecoin supply are market-wide risk appetite, and
 *    apply to every symbol equally — which also means they cannot separate
 *    one coin from another.
 *
 * So the stage reports `unavailable` far more often than it reports a score,
 * and it is designed to. A stage that always has an opinion, on data that
 * cannot support one, is worse than a stage that admits it has none.
 */
import { stagePass, stageUnavailable, type StageResult } from "@/core/pipeline/types";
import type { Factor } from "@/core/analysis/types";
import type { Availability } from "@/shared/availability";
import type { Direction, ProtocolTvl } from "@/core/types";

export interface OnchainInput {
  readonly symbol: string;
  /** Ticker without the quote asset, e.g. "SOL". */
  readonly ticker: string;
  /** This token's protocol, when DefiLlama knows one. */
  readonly protocol: Availability<ProtocolTvl>;
  /** Sector-wide TVL — risk appetite, identical for every symbol. */
  readonly totalTvl: Availability<number>;
  /** Total TVL 7 days ago, for the trend. Null when only one reading exists. */
  readonly totalTvl7dAgo: number | null;
  readonly direction: Direction;
  readonly now: number;
}

/** Confidence penalty when the stage cannot read anything at all. */
const UNAVAILABLE_PENALTY = 0.15;

/** Assets whose "protocol TVL" is a category error, not a missing value. */
const NO_PROTOCOL = new Set(["BTC", "XBT", "DOGE", "LTC", "XRP", "BCH", "XMR"]);

const WEIGHTS = {
  protocolTvlTrend: 55,
  sectorTvlTrend: 30,
  revenue: 15,
} as const;

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

const clamp = (n: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, n));

export interface OnchainResult extends StageResult {
  readonly protocolTvl: number | null;
  readonly sectorTvlChange7dPct: number | null;
}

export function runOnchain(input: OnchainInput): OnchainResult {
  const started = Date.now();
  const factors: Factor[] = [];
  const warnings: string[] = [];
  let score = 0;
  let weightUsed = 0;

  const base = {
    protocolTvl: input.protocol.available ? input.protocol.value.tvl : null,
    sectorTvlChange7dPct: null as number | null,
  };

  // ── the token's own protocol ────────────────────────────────────────────
  const tickerHasProtocol = !NO_PROTOCOL.has(input.ticker.toUpperCase());

  if (!tickerHasProtocol) {
    factors.push({
      id: "protocol_tvl", label: "القيمة المقفلة للبروتوكول", value: null,
      display: "لا ينطبق",
      contribution: 0,
      note:
        `${input.ticker} ليست بروتوكولاً — لا قيمة مقفلة تُقاس لها. ` +
        "هذا ليس نقصاً في البيانات بل عدم انطباق، ولا يُحتسب خصماً.",
    });
  } else if (input.protocol.available) {
    const p = input.protocol.value;
    const change7d = p.change7d;

    if (change7d !== null && Number.isFinite(change7d)) {
      // ±20% over a week is a large move in locked capital; scale to that.
      const normalized = clamp(change7d / 20, -1, 1);
      const contribution = normalized * WEIGHTS.protocolTvlTrend;
      score += contribution;
      weightUsed += WEIGHTS.protocolTvlTrend;
      base.protocolTvl = p.tvl;

      factors.push({
        id: "protocol_tvl", label: "القيمة المقفلة للبروتوكول", value: change7d,
        display: `${fmt(p.tvl / 1e6, 1)} مليون · ${change7d >= 0 ? "+" : "−"}${fmt(Math.abs(change7d), 1)}% في 7 أيام`,
        contribution,
        note:
          "رأس مال أقفله أشخاص فعلاً في البروتوكول — ليس مشتقّاً من السعر. " +
          (change7d >= 0
            ? "ارتفاعها مع سعر هابط تباعدٌ لصالح القيمة: المال يدخل بينما السعر ينزل."
            : "انخفاضها يعني خروج رأس المال، وهو ما يسبق ضعف السعر غالباً لا يتبعه."),
      });
    } else {
      warnings.push("القيمة المقفلة معروفة لكن دون تغيّر أسبوعي — لم تُحتسب");
    }

    if (p.revenue24h !== null && p.revenue24h !== undefined && Number.isFinite(p.revenue24h)) {
      // Revenue is a quality signal, not a direction: a protocol that earns is
      // a protocol with users. It nudges, it does not decide.
      const annualized = p.revenue24h * 365;
      const ratio = p.tvl > 0 ? annualized / p.tvl : 0;
      const normalized = clamp(ratio * 10, 0, 1);
      const contribution = normalized * WEIGHTS.revenue;
      score += contribution;
      weightUsed += WEIGHTS.revenue;

      factors.push({
        id: "protocol_revenue", label: "إيراد البروتوكول", value: p.revenue24h,
        display: `${fmt(p.revenue24h / 1e3, 1)} ألف/يوم · ${fmt(ratio * 100, 1)}% من القيمة المقفلة سنوياً`,
        contribution,
        note: "بروتوكول يكسب رسوماً هو بروتوكول له مستخدمون. إشارة جودة لا اتجاه.",
      });
    }
  } else {
    warnings.push(`لا بروتوكول معروف لـ ${input.ticker} لدى DefiLlama`);
  }

  // ── the sector ──────────────────────────────────────────────────────────
  if (input.totalTvl.available && input.totalTvl7dAgo !== null && input.totalTvl7dAgo > 0) {
    const change = ((input.totalTvl.value - input.totalTvl7dAgo) / input.totalTvl7dAgo) * 100;
    base.sectorTvlChange7dPct = change;

    const normalized = clamp(change / 10, -1, 1);
    const contribution = normalized * WEIGHTS.sectorTvlTrend;
    score += contribution;
    weightUsed += WEIGHTS.sectorTvlTrend;

    factors.push({
      id: "sector_tvl", label: "القيمة المقفلة للقطاع", value: change,
      display: `${fmt(input.totalTvl.value / 1e9, 1)} مليار · ${change >= 0 ? "+" : "−"}${fmt(Math.abs(change), 1)}% في 7 أيام`,
      contribution,
      note:
        "شهية المخاطرة في القطاع كله. تنطبق على كل العملات بالتساوي — " +
        "ولذلك لا تستطيع التمييز بين عملة وأخرى، بل ترفع أو تخفض الجميع معاً.",
    });
  } else if (input.totalTvl.available) {
    warnings.push("القيمة المقفلة للقطاع معروفة لكن دون قراءة سابقة للمقارنة — لم تُحتسب");
  }

  // ── nothing readable at all ─────────────────────────────────────────────
  if (weightUsed === 0) {
    const why = !tickerHasProtocol && !input.totalTvl.available
      ? `${input.ticker} ليست بروتوكولاً، ولا تتوفّر قراءة للقطاع`
      : warnings.join("؛ ") || "لا مصدر متاح لبيانات السلسلة";

    return {
      ...stageUnavailable("onchain", why, UNAVAILABLE_PENALTY, {
        factors, warnings, durationMs: Date.now() - started,
      }),
      ...base,
    };
  }

  // Renormalize to the weight actually used, so a missing sub-reading does not
  // drag the score toward zero — the same rule the council applies to stages.
  const normalizedScore = clamp((score / weightUsed) * 100);

  const arabic =
    `${input.symbol} — بيانات السلسلة من DefiLlama: ` +
    factors.filter((f) => f.contribution !== 0).map((f) => `${f.label} ${f.display}`).join("، ") +
    `. النتيجة ${fmt(normalizedScore, 0)}. ` +
    "هذه ليست تدفّقات المنصّات: لا مزوّد مجاني لها، وغيابها معلن ومخصوم." +
    (warnings.length ? ` ملاحظات: ${warnings.join("، ")}.` : "");

  return {
    ...stagePass("onchain", {
      score: normalizedScore,
      bias: normalizedScore > 15 ? "bullish" : normalizedScore < -15 ? "bearish" : "neutral",
      factors,
      confidencePenalty: 0,
      warnings,
      arabic,
      dataAgeMs: null,
      durationMs: Date.now() - started,
    }),
    ...base,
  };
}
