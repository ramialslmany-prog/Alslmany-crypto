/**
 * Order book: imbalance, liquidity walls, and whether those walls are real.
 *
 * THE QUESTION A SINGLE SNAPSHOT CANNOT ANSWER: a large resting order looks
 * identical whether it is genuine supply or a spoof that will vanish the
 * moment price approaches it. Only a SEQUENCE of snapshots separates them —
 * so `trackWalls` takes several, and a wall that shrinks as price approaches
 * is reported as PULLED, which is the opposite signal from a wall that holds.
 *
 * Treating every visible wall as real is how a bot gets drawn into fading a
 * level that was never there.
 */
import type { OrderBook, OrderBookLevel } from "@/core/types";

export interface BookImbalance {
  /** Bid notional within the band. */
  readonly bidDepth: number;
  readonly askDepth: number;
  /** −1 (all asks) … +1 (all bids). */
  readonly imbalance: number;
  /** Spread in basis points of mid. */
  readonly spreadBps: number;
  readonly mid: number;
  /** The band the depth was measured over, as a percentage. */
  readonly bandPct: number;
  readonly arabic: string;
}

export function analyzeImbalance(book: OrderBook, bandPct = 1): BookImbalance {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  if (!(mid > 0)) {
    return {
      bidDepth: 0, askDepth: 0, imbalance: 0, spreadBps: NaN, mid: 0, bandPct,
      arabic: "دفتر الأوامر فارغ أو غير صالح.",
    };
  }

  const band = mid * (bandPct / 100);
  const bidDepth = notionalWithin(book.bids, mid - band, mid);
  const askDepth = notionalWithin(book.asks, mid, mid + band);
  const total = bidDepth + askDepth;
  const imbalance = total > 0 ? (bidDepth - askDepth) / total : 0;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  return {
    bidDepth, askDepth, imbalance, spreadBps, mid, bandPct,
    arabic:
      `ضمن ${bandPct}% من السعر: عمق شراء ${fmt(bidDepth)} مقابل بيع ${fmt(askDepth)} ` +
      `(اختلال ${(imbalance * 100).toFixed(0)}%). ` +
      (Math.abs(imbalance) < 0.15
        ? "الدفتر متوازن."
        : imbalance > 0
          ? "ثقل الدفتر في جانب الشراء."
          : "ثقل الدفتر في جانب البيع.") +
      " والاختلال لقطة لحظية تتغيّر بالثواني — لا يُبنى عليه وحده قرار.",
  };
}

function notionalWithin(levels: readonly OrderBookLevel[], low: number, high: number): number {
  let sum = 0;
  for (const l of levels) {
    if (l.price >= low && l.price <= high) sum += l.price * l.quantity;
  }
  return sum;
}

// ── walls ────────────────────────────────────────────────────────────────────

export interface Wall {
  readonly side: "bid" | "ask";
  readonly price: number;
  readonly notional: number;
  /** How many times the average level at this depth. */
  readonly multiple: number;
  /** Distance from mid, in percent. */
  readonly distancePct: number;
}

/**
 * `bandPct` defaults to 5%: a wall further from price than that will not be
 * reached within the life of most setups, and counting it would clutter the
 * reading with levels the trade never interacts with.
 */
export function findWalls(book: OrderBook, minMultiple = 5, bandPct = 5): Wall[] {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
  if (!(mid > 0)) return [];

  const band = mid * (bandPct / 100);
  const out: Wall[] = [];

  const scan = (levels: readonly OrderBookLevel[], side: "bid" | "ask") => {
    const within = levels.filter((l) => Math.abs(l.price - mid) <= band);
    if (within.length < 5) return;
    const notionals = within.map((l) => l.price * l.quantity);

    // THE BASELINE IS THE MEDIAN, NOT THE MEAN.
    //
    // A wall is by definition an outlier, and an outlier included in its own
    // mean hides itself: five levels of 10 and one of 500 have a mean of 91,
    // against which the 500 reads as only 5.5× — and a slightly smaller wall
    // drops below any sane threshold entirely. The median is unmoved by the
    // very value being tested, which is the property this needs.
    const sorted = [...notionals].sort((a, b) => a - b);
    const mid_ = Math.floor(sorted.length / 2);
    const baseline = sorted.length % 2 === 0
      ? (sorted[mid_ - 1] + sorted[mid_]) / 2
      : sorted[mid_];
    if (!(baseline > 0)) return;

    within.forEach((l, i) => {
      const notional = notionals[i];
      const multiple = notional / baseline;
      if (multiple >= minMultiple) {
        out.push({
          side, price: l.price, notional, multiple,
          distancePct: ((l.price - mid) / mid) * 100,
        });
      }
    });
  };

  scan(book.bids, "bid");
  scan(book.asks, "ask");
  return out.sort((a, b) => b.notional - a.notional).slice(0, 10);
}

export type WallBehaviour = "held" | "pulled" | "grew" | "consumed" | "unknown";

export interface TrackedWall extends Wall {
  readonly behaviour: WallBehaviour;
  /** Fraction of the original size still there. */
  readonly remaining: number;
  /** How much closer price got, in percent, across the snapshots. */
  readonly approachedBy: number;
  readonly arabic: string;
}

/**
 * Follow walls across snapshots and classify what they did.
 *
 * Needs at least two snapshots, ordered oldest to newest. A wall that shrinks
 * WHILE PRICE APPROACHES was pulled — the order was never intended to be
 * filled, and the level it implied does not exist. A wall that holds through
 * an approach is real supply or demand.
 */
export function trackWalls(
  snapshots: readonly OrderBook[],
  minMultiple = 5,
): TrackedWall[] {
  if (snapshots.length < 2) return [];

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const initial = findWalls(first, minMultiple);
  if (initial.length === 0) return [];

  const midOf = (b: OrderBook): number => {
    const bid = b.bids[0]?.price ?? 0;
    const ask = b.asks[0]?.price ?? 0;
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  };

  const firstMid = midOf(first);
  const lastMid = midOf(last);

  // Price tolerance for matching a level across snapshots.
  const tolerance = firstMid * 0.0004;

  return initial.map((wall): TrackedWall => {
    const levels = wall.side === "bid" ? last.bids : last.asks;
    const match = levels.find((l) => Math.abs(l.price - wall.price) <= tolerance);
    const nowNotional = match ? match.price * match.quantity : 0;
    const remaining = wall.notional > 0 ? nowNotional / wall.notional : 0;

    const distanceBefore = Math.abs(wall.price - firstMid);
    const distanceAfter = Math.abs(wall.price - lastMid);
    const approachedBy = firstMid > 0 ? ((distanceBefore - distanceAfter) / firstMid) * 100 : 0;
    const approaching = distanceAfter < distanceBefore;

    let behaviour: WallBehaviour;
    let arabic: string;

    if (remaining >= 0.95) {
      behaviour = remaining > 1.2 ? "grew" : "held";
      arabic = approaching
        ? `الجدار صمد بينما اقترب السعر منه — سيولة حقيقية، لا وهمية.`
        : `الجدار ثابت، لكن السعر لم يقترب منه بعد فلم يُختبر.`;
    } else if (remaining <= 0.3) {
      if (approaching) {
        // The informative case: it vanished as price came to it.
        behaviour = "pulled";
        arabic =
          `الجدار اختفى بينما كان السعر يقترب منه — أمر وهمي لم يُقصَد تنفيذه، ` +
          `والمستوى الذي كان يوحي به غير موجود.`;
      } else {
        behaviour = "consumed";
        arabic = `الجدار استُهلك بالتداول عنده — سيولة حقيقية أُكلت.`;
      }
    } else {
      behaviour = approaching && remaining < 0.6 ? "pulled" : "held";
      arabic =
        `بقي ${(remaining * 100).toFixed(0)}% من الجدار` +
        (approaching ? " بينما اقترب السعر — تآكل جزئي مشبوه." : " دون اقتراب السعر.");
    }

    return { ...wall, behaviour, remaining, approachedBy, arabic };
  });
}

const fmt = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0);
