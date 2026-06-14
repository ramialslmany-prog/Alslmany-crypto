/**
 * Price validation engine.
 *
 * Takes raw per-exchange quotes and produces a defensible "real" price plus
 * confidence / integrity / reliability scores and a VALID·CAUTION·REJECT
 * verdict. The philosophy: never trust a signal if the price itself isn't
 * trustworthy. Robust statistics (median + MAD) make this resistant to a
 * single manipulated venue.
 */
import type { SourceQuote } from "@/lib/exchanges";

export type Verdict = "VALID" | "CAUTION" | "REJECT";

export interface ValidationResult {
  symbol: string;
  validatedPrice: number | null;
  medianPrice: number | null;
  sources: SourceQuote[];
  consensusCount: number;
  totalSources: number;
  spreadPct: number;
  maxDeviationPct: number;
  confidence: number; // 0-100
  integrity: number; // 0-100
  verdict: Verdict;
  reasons: string[];
  updatedAt: number;
}

/** Tunable risk thresholds — a production config would expose these per-asset. */
export const THRESHOLDS = {
  outlierPct: 0.8, // a venue >0.8% off the median is treated as an outlier
  rejectSpreadPct: 2.5, // cross-venue spread above this → reject
  rejectDeviationPct: 3.0, // any single venue this far off → manipulation suspected
  minSourcesValid: 3, // fewer live venues than this → reject (low liquidity/confidence)
  cautionConfidence: 70,
  rejectConfidence: 40,
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export function validate(symbol: string, sources: SourceQuote[]): ValidationResult {
  const updatedAt = Date.now();
  const totalSources = sources.length;
  const live = sources.filter((s) => s.ok && typeof s.price === "number" && s.price! > 0);

  // Hard fail: not enough live venues to form a consensus.
  if (live.length < THRESHOLDS.minSourcesValid) {
    return {
      symbol, validatedPrice: null, medianPrice: null, sources,
      consensusCount: live.length, totalSources,
      spreadPct: 0, maxDeviationPct: 0, confidence: 0, integrity: 0,
      verdict: "REJECT",
      reasons: [`Only ${live.length}/${totalSources} venues responded — insufficient consensus`],
      updatedAt,
    };
  }

  const prices = live.map((s) => s.price!);
  const med = median(prices);

  // Per-venue deviation + outlier flag (robust to a single manipulated feed).
  for (const s of live) {
    const dev = ((s.price! - med) / med) * 100;
    s.deviationPct = dev;
    s.outlier = Math.abs(dev) > THRESHOLDS.outlierPct;
    const latencyPenalty = Math.min(40, s.latencyMs / 30);
    s.reliability = Math.round(clamp(100 - latencyPenalty - (s.outlier ? 35 : 0)));
  }

  const inliers = live.filter((s) => !s.outlier);
  const used = inliers.length >= THRESHOLDS.minSourcesValid ? inliers : live;

  // Volume-weighted validated price across trusted venues.
  const totalVol = used.reduce((a, s) => a + (s.quoteVolume ?? 0), 0);
  const validatedPrice =
    totalVol > 0
      ? used.reduce((a, s) => a + s.price! * (s.quoteVolume ?? 0), 0) / totalVol
      : used.reduce((a, s) => a + s.price!, 0) / used.length;

  // Dispersion metrics.
  const usedPrices = used.map((s) => s.price!);
  const spreadPct = ((Math.max(...usedPrices) - Math.min(...usedPrices)) / med) * 100;
  const maxDeviationPct = Math.max(...live.map((s) => Math.abs(s.deviationPct ?? 0)));
  const mean = usedPrices.reduce((a, b) => a + b, 0) / usedPrices.length;
  const stdev = Math.sqrt(usedPrices.reduce((a, b) => a + (b - mean) ** 2, 0) / usedPrices.length);
  const stdevPct = (stdev / med) * 100;

  const outliers = live.filter((s) => s.outlier);
  const failed = totalSources - live.length;

  // Confidence: agreement, breadth, and freshness all contribute.
  let confidence = 100;
  confidence -= spreadPct * 22;
  confidence -= outliers.length * 12;
  confidence -= failed * 6;
  if (live.length < 5) confidence -= (5 - live.length) * 9;
  confidence = Math.round(clamp(confidence));

  // Integrity: how tightly the trusted venues agree.
  const integrity = Math.round(clamp(100 - stdevPct * 55));

  // Verdict.
  const reasons: string[] = [];
  let verdict: Verdict = "VALID";

  if (
    spreadPct > THRESHOLDS.rejectSpreadPct ||
    maxDeviationPct > THRESHOLDS.rejectDeviationPct ||
    confidence < THRESHOLDS.rejectConfidence
  ) {
    verdict = "REJECT";
    if (spreadPct > THRESHOLDS.rejectSpreadPct) reasons.push(`Cross-venue spread ${spreadPct.toFixed(2)}% exceeds ${THRESHOLDS.rejectSpreadPct}%`);
    if (maxDeviationPct > THRESHOLDS.rejectDeviationPct) reasons.push(`A venue is ${maxDeviationPct.toFixed(2)}% off consensus — manipulation suspected`);
    if (confidence < THRESHOLDS.rejectConfidence) reasons.push(`Confidence ${confidence} below reject floor`);
  } else if (confidence < THRESHOLDS.cautionConfidence || outliers.length > 0 || spreadPct > 0.6 || live.length < 5) {
    verdict = "CAUTION";
    if (outliers.length > 0) reasons.push(`${outliers.length} venue(s) flagged as outliers: ${outliers.map((o) => o.exchange).join(", ")}`);
    if (spreadPct > 0.6) reasons.push(`Elevated spread ${spreadPct.toFixed(2)}%`);
    if (live.length < 5) reasons.push(`Only ${live.length} venues live`);
    if (confidence < THRESHOLDS.cautionConfidence) reasons.push(`Confidence ${confidence} — confirm before acting`);
  } else {
    reasons.push(`${used.length} venues agree within ${spreadPct.toFixed(2)}% — price verified`);
  }

  return {
    symbol, validatedPrice, medianPrice: med, sources,
    consensusCount: used.length, totalSources,
    spreadPct, maxDeviationPct, confidence, integrity, verdict, reasons, updatedAt,
  };
}
