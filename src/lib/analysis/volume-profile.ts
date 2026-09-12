import type { Candle } from "@/lib/market/types";

/**
 * Volume profile.
 *
 * Most retail analysis asks *when* volume happened. A profile asks *at what
 * price* it happened, which is the more useful question: it shows where the
 * market actually agreed on value, and those prices behave differently from
 * ones it merely passed through.
 *
 *  - POC (point of control): the single price with the most traded volume. It
 *    acts as a magnet, and price tends to return to it.
 *  - Value area: the band containing 70% of volume. Inside it, expect
 *    rotation; outside, expect either acceptance or rapid rejection.
 *  - HVN (high-volume node): heavily traded shelf — support and resistance
 *    that has real inventory behind it, not just a touch on a chart.
 *  - LVN (low-volume node): a price the market rejected quickly. Moves travel
 *    through these fast, which makes them poor places to put a target and good
 *    places to expect acceleration.
 *
 * Each candle's volume is distributed across its high-low range rather than
 * dumped at its close, because a bar with a wide range genuinely traded across
 * all of it.
 */

export type VolumeNode = {
  /** Mid-price of the bin. */
  price: number;
  volume: number;
  /** Share of total volume in this bin, 0–100. */
  sharePct: number;
};

export type VolumeProfile = {
  /** Price with the greatest traded volume. */
  poc: number;
  /** Upper bound of the 70% value area. */
  valueAreaHigh: number;
  valueAreaLow: number;
  /** Where the current price sits relative to the value area. */
  position: "above" | "inside" | "below";
  nodes: VolumeNode[];
  highVolumeNodes: VolumeNode[];
  lowVolumeNodes: VolumeNode[];
  totalVolume: number;
};

const VALUE_AREA_SHARE = 0.7;

export function buildVolumeProfile(candles: Candle[], bins = 48): VolumeProfile | null {
  if (candles.length < 20) return null;

  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const span = high - low;
  if (!(span > 0)) return null;

  const binSize = span / bins;
  const volumes = new Array<number>(bins).fill(0);

  for (const candle of candles) {
    const range = candle.h - candle.l;
    if (range <= 0) {
      // A flat bar trades entirely at one price.
      const index = Math.min(bins - 1, Math.max(0, Math.floor((candle.c - low) / binSize)));
      volumes[index] += candle.v;
      continue;
    }

    // Spread the bar's volume evenly across the bins its range covers.
    const startBin = Math.max(0, Math.floor((candle.l - low) / binSize));
    const endBin = Math.min(bins - 1, Math.floor((candle.h - low) / binSize));
    const touched = endBin - startBin + 1;
    const share = candle.v / touched;
    for (let i = startBin; i <= endBin; i++) volumes[i] += share;
  }

  const totalVolume = volumes.reduce((s, v) => s + v, 0);
  if (!(totalVolume > 0)) return null;

  const nodes: VolumeNode[] = volumes.map((volume, i) => ({
    price: low + binSize * (i + 0.5),
    volume,
    sharePct: (volume / totalVolume) * 100,
  }));

  // POC is the fullest bin.
  let pocIndex = 0;
  for (let i = 1; i < volumes.length; i++) if (volumes[i] > volumes[pocIndex]) pocIndex = i;

  // Grow outward from the POC, always taking the fuller neighbour, until 70%
  // of volume is enclosed. This is the standard construction and it produces a
  // contiguous band rather than a scattered set of bins.
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let captured = volumes[pocIndex];
  const target = totalVolume * VALUE_AREA_SHARE;

  while (captured < target && (lowIndex > 0 || highIndex < bins - 1)) {
    const below = lowIndex > 0 ? volumes[lowIndex - 1] : -1;
    const above = highIndex < bins - 1 ? volumes[highIndex + 1] : -1;
    if (above >= below) {
      highIndex++;
      captured += Math.max(above, 0);
    } else {
      lowIndex--;
      captured += Math.max(below, 0);
    }
  }

  const price = candles[candles.length - 1].c;
  const valueAreaHigh = low + binSize * (highIndex + 1);
  const valueAreaLow = low + binSize * lowIndex;

  const meanShare = 100 / bins;
  const sorted = [...nodes].sort((a, b) => b.volume - a.volume);

  return {
    poc: nodes[pocIndex].price,
    valueAreaHigh,
    valueAreaLow,
    position: price > valueAreaHigh ? "above" : price < valueAreaLow ? "below" : "inside",
    nodes,
    // A shelf worth naming holds clearly more than an even share of volume.
    highVolumeNodes: sorted.filter((n) => n.sharePct >= meanShare * 1.8).slice(0, 5),
    // Thin prices, restricted to bins the market actually visited.
    lowVolumeNodes: sorted
      .filter((n) => n.volume > 0 && n.sharePct <= meanShare * 0.35)
      .slice(-5)
      .reverse(),
    totalVolume,
  };
}

export type VolumeProfileRead = {
  profile: VolumeProfile | null;
  score: number;
  detail: string;
};

/**
 * Turn the profile into a directional read.
 *
 * Trading above the value area on acceptance is strength; being far above it
 * is stretched and invites a return to the POC. Below the value area is the
 * mirror. Inside it, the honest answer is that the profile says nothing
 * directional, and it returns zero rather than manufacturing a lean.
 */
export function readVolumeProfile(candles: Candle[]): VolumeProfileRead {
  const profile = buildVolumeProfile(candles);
  if (!profile) return { profile: null, score: 0, detail: "insufficient data" };

  const price = candles[candles.length - 1].c;
  const distanceToPoc = ((price - profile.poc) / profile.poc) * 100;

  if (profile.position === "above") {
    const stretched = distanceToPoc > 12;
    return {
      profile,
      score: stretched ? -5 : 7,
      detail: stretched
        ? `${distanceToPoc.toFixed(1)}% above POC — stretched`
        : `accepted above value area`,
    };
  }

  if (profile.position === "below") {
    const washedOut = distanceToPoc < -12;
    return {
      profile,
      score: washedOut ? 4 : -7,
      detail: washedOut
        ? `${Math.abs(distanceToPoc).toFixed(1)}% below POC — washed out`
        : `trading below value area`,
    };
  }

  return { profile, score: 0, detail: "inside the value area — rotational" };
}
