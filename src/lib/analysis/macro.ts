import type { CoinMarket } from "@/lib/market/types";
import type { Evidence } from "./regime";

/**
 * Capital rotation between Bitcoin and everything else.
 *
 * Buying an altcoin while Bitcoin dominance is rising is swimming against the
 * tide, however good the chart looks: capital is leaving the rest of the
 * market for Bitcoin, and a rising altcoin in that environment is fighting
 * flow rather than riding it. The engine could see an asset's own chart and
 * the market's overall direction, but not *where within the market* money was
 * actually going.
 *
 * Altcoin season is measured the way the market itself defines it — the share
 * of major alts outperforming Bitcoin over the recent window — rather than
 * from a third-party index, so it stays computable from data already loaded
 * and is auditable from the same numbers shown elsewhere on the site.
 */

export type RotationPhase =
  /** Money concentrating into Bitcoin; alts bleed against it. */
  | "btc-season"
  /** No clear rotation. */
  | "neutral"
  /** Money spreading into alts; they outperform. */
  | "alt-season";

export type MacroRead = {
  available: boolean;
  /** Share of tracked alts outperforming Bitcoin, 0–100. */
  altStrengthPct: number | null;
  btcDominance: number | null;
  /** Change in dominance over the window, in percentage points. */
  dominanceChange: number | null;
  phase: RotationPhase;
  /** Signed contribution, applied only to altcoins. */
  score: number;
  evidence: Evidence[];
  warnings: string[];
};

const UNAVAILABLE: MacroRead = {
  available: false,
  altStrengthPct: null,
  btcDominance: null,
  dominanceChange: null,
  phase: "neutral",
  score: 0,
  evidence: [],
  warnings: [],
};

/**
 * Measure rotation from the market list.
 *
 * `dominanceChange` is optional because a single snapshot cannot show a trend;
 * when it is unknown the phase is decided on relative performance alone rather
 * than inventing a direction.
 */
export function readMacro(input: {
  markets: CoinMarket[];
  btcDominance: number | null;
  dominanceChange?: number | null;
}): MacroRead {
  const { markets, btcDominance } = input;
  const btc = markets.find((m) => m.symbol === "BTC");

  // Compare over 7 days when available, since a single day is noise. Assets
  // with no 7d figure are excluded rather than treated as flat.
  const usable = markets.filter(
    (m) => m.symbol !== "BTC" && m.marketCap > 0 && Number.isFinite(m.changePct7d) && m.changePct7d !== 0,
  );

  if (!btc || usable.length < 8) return UNAVAILABLE;

  const btcChange = btc.changePct7d;
  const outperforming = usable.filter((m) => m.changePct7d > btcChange).length;
  const altStrengthPct = (outperforming / usable.length) * 100;
  const dominanceChange = input.dominanceChange ?? null;

  const evidence: Evidence[] = [];
  const warnings: string[] = [];
  let score = 0;

  const add = (key: string, weight: number, detail: string) => {
    evidence.push({
      key,
      direction: weight > 0 ? "bullish" : weight < 0 ? "bearish" : "neutral",
      weight,
      detail,
    });
    score += weight;
  };

  // The widely used convention is that three quarters of majors beating
  // Bitcoin marks an alt season, and the mirror marks a Bitcoin season.
  let phase: RotationPhase = "neutral";
  if (altStrengthPct >= 75) {
    phase = "alt-season";
    add("macro.altSeason", 10, `${altStrengthPct.toFixed(0)}% of alts outperforming BTC`);
  } else if (altStrengthPct <= 25) {
    phase = "btc-season";
    add("macro.btcSeason", -10, `only ${altStrengthPct.toFixed(0)}% of alts outperforming BTC`);
    warnings.push("warn.btcSeason");
  } else {
    add("macro.rotationNeutral", 0, `${altStrengthPct.toFixed(0)}% of alts outperforming BTC`);
  }

  if (dominanceChange !== null) {
    if (dominanceChange >= 1.5) {
      add("macro.dominanceRising", -7, `BTC dominance +${dominanceChange.toFixed(1)}pts`);
      if (phase === "neutral") warnings.push("warn.btcSeason");
    } else if (dominanceChange <= -1.5) {
      add("macro.dominanceFalling", 7, `BTC dominance ${dominanceChange.toFixed(1)}pts`);
    }
  }

  return {
    available: true,
    altStrengthPct,
    btcDominance,
    dominanceChange,
    phase,
    score: Math.max(-20, Math.min(15, Math.round(score))),
    evidence,
    warnings,
  };
}

/**
 * Rotation only applies to alts.
 *
 * Bitcoin cannot be swimming against its own dominance, so applying the score
 * to BTC itself would be double-counting the same fact in both directions.
 */
export function macroFor(symbol: string, read: MacroRead): MacroRead {
  if (symbol.toUpperCase() !== "BTC") return read;
  return { ...read, score: 0, evidence: [], warnings: [] };
}
