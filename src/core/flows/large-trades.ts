/**
 * Anomalous large trades.
 *
 * "Large" has no absolute meaning — a 50 BTC print is routine on Bitcoin and
 * impossible on a small alt. So size is measured in STANDARD DEVIATIONS above
 * the recent median, which adapts to whatever this market's normal is.
 *
 * Median rather than mean on purpose: a handful of whales in the sample would
 * drag a mean upward and hide the very prints we are looking for.
 */
import type { Trade } from "@/core/types";

export interface LargeTrade {
  readonly timestamp: number;
  readonly price: number;
  readonly quoteQuantity: number;
  readonly side: "buy" | "sell";
  /** How many robust standard deviations above the median this print is. */
  readonly sigma: number;
}

export interface LargeTradeResult {
  readonly trades: readonly LargeTrade[];
  readonly buyNotional: number;
  readonly sellNotional: number;
  /** −1..1: which side the large prints favoured. */
  readonly bias: number;
  /** Large-print notional as a fraction of all notional in the window. */
  readonly shareOfVolume: number;
  readonly arabic: string;
}

/** Median absolute deviation — a spread measure whales cannot distort. */
function medianAbsoluteDeviation(values: number[], median: number): number {
  const deviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mid = Math.floor(deviations.length / 2);
  return deviations.length % 2 === 0
    ? (deviations[mid - 1] + deviations[mid]) / 2
    : deviations[mid];
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function findLargeTrades(trades: readonly Trade[], sigmaThreshold = 4): LargeTradeResult {
  if (trades.length < 30) {
    return {
      trades: [], buyNotional: 0, sellNotional: 0, bias: 0, shareOfVolume: 0,
      arabic: "عدد الصفقات غير كافٍ لتمييز الشاذّ منها.",
    };
  }

  const notionals = trades.map((t) => t.quoteQuantity);
  const sorted = [...notionals].sort((a, b) => a - b);
  const median = medianOf(sorted);
  const mad = medianAbsoluteDeviation(notionals, median);
  // 1.4826 scales MAD to match a standard deviation for normal data.
  const robustSigma = mad * 1.4826 || median * 0.5 || 1;

  const large: LargeTrade[] = [];
  for (const t of trades) {
    const sigma = (t.quoteQuantity - median) / robustSigma;
    if (sigma >= sigmaThreshold) {
      large.push({
        timestamp: t.timestamp,
        price: t.price,
        quoteQuantity: t.quoteQuantity,
        // buyerIsMaker true means a SELL crossed the spread.
        side: t.buyerIsMaker ? "sell" : "buy",
        sigma,
      });
    }
  }

  const buyNotional = large.filter((t) => t.side === "buy").reduce((s, t) => s + t.quoteQuantity, 0);
  const sellNotional = large.filter((t) => t.side === "sell").reduce((s, t) => s + t.quoteQuantity, 0);
  const totalLarge = buyNotional + sellNotional;
  const totalAll = notionals.reduce((s, v) => s + v, 0);

  const bias = totalLarge > 0 ? (buyNotional - sellNotional) / totalLarge : 0;
  const shareOfVolume = totalAll > 0 ? totalLarge / totalAll : 0;

  return {
    trades: large.sort((a, b) => b.quoteQuantity - a.quoteQuantity).slice(0, 20),
    buyNotional,
    sellNotional,
    bias,
    shareOfVolume,
    arabic: narrate(large.length, bias, shareOfVolume),
  };
}

function narrate(count: number, bias: number, share: number): string {
  if (count === 0) return "لا توجد صفقات كبيرة شاذّة في هذه النافذة.";

  const direction =
    Math.abs(bias) < 0.2 ? "موزّعة على الجانبين" :
    bias > 0 ? "غالبها شراء مبادر" : "غالبها بيع مبادر";

  const weight =
    share > 0.3 ? "وهي تشكّل حصّة كبيرة من الحجم الكلي — المشاركون الكبار يحرّكون السعر هنا." :
    share > 0.1 ? "وحصّتها من الحجم معتبرة." :
    "لكن حصّتها من الحجم صغيرة، فأثرها محدود.";

  return `${count} صفقة كبيرة شاذّة، ${direction}. ${weight}`;
}
