import type { Evidence } from "./regime";

/**
 * Supply structure and dilution pressure.
 *
 * The methodology calls tokenomics the most important part of fundamental
 * analysis, and the reason is mechanical rather than philosophical: a token
 * with 15% of its supply circulating has 85% still to arrive, and every one of
 * those units is a future seller. Two assets with identical charts and
 * identical market caps are structurally different trades if one is fully
 * circulating and the other is not.
 *
 * The engine could not see any of this. It compared price action across assets
 * whose supply schedules made them incomparable.
 *
 * What this module cannot see is stated plainly rather than guessed: the actual
 * *vesting calendar*. Knowing 85% is yet to unlock is useful; knowing that 12%
 * of it unlocks next Tuesday would be far more useful, and that data is not in
 * any free source. Absence of a cliff warning here is not evidence there is no
 * cliff.
 */

export type SupplyInput = {
  circulating: number;
  /** Maximum supply, when the token has a hard cap. */
  maxSupply: number | null;
  /** Total minted so far. */
  totalSupply: number | null;
  marketCap: number;
  /** Fully diluted valuation, when it can be computed. */
  fullyDiluted: number | null;
  athChangePct: number;
  rank: number;
};

export type DilutionRisk = "none" | "low" | "moderate" | "high" | "severe";

export type TokenomicsRead = {
  available: boolean;
  /** Share of the eventual supply already circulating, 0–100. */
  circulatingPct: number | null;
  /** FDV ÷ market cap. Above ~2 means most of the value is not yet issued. */
  fdvRatio: number | null;
  dilutionRisk: DilutionRisk;
  /** How far below the all-time high, as a positive percentage. */
  drawdownFromAth: number | null;
  score: number;
  evidence: Evidence[];
  warnings: string[];
  /** Shrinks position size when future supply overhangs the trade. */
  sizeMultiplier: number;
};

const UNAVAILABLE: TokenomicsRead = {
  available: false,
  circulatingPct: null,
  fdvRatio: null,
  dilutionRisk: "none",
  drawdownFromAth: null,
  score: 0,
  evidence: [],
  warnings: [],
  sizeMultiplier: 1,
};

export function readTokenomics(input: SupplyInput | null): TokenomicsRead {
  if (!input || !(input.circulating > 0) || !(input.marketCap > 0)) return UNAVAILABLE;

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

  // Eventual supply: the hard cap if there is one, otherwise what has been
  // minted. A token with neither is treated as unknown rather than as safe.
  const eventual = input.maxSupply ?? input.totalSupply;
  const circulatingPct =
    eventual && eventual > 0 ? Math.min(100, (input.circulating / eventual) * 100) : null;

  const fdv =
    input.fullyDiluted ??
    (eventual && eventual > 0 ? (input.marketCap / input.circulating) * eventual : null);
  const fdvRatio = fdv && input.marketCap > 0 ? fdv / input.marketCap : null;

  let dilutionRisk: DilutionRisk = "none";
  let sizeMultiplier = 1;

  if (circulatingPct !== null) {
    if (circulatingPct >= 95) {
      add("token.fullyCirculating", 8, `${circulatingPct.toFixed(0)}% of supply circulating`);
      dilutionRisk = "none";
    } else if (circulatingPct >= 80) {
      add("token.mostlyCirculating", 4, `${circulatingPct.toFixed(0)}% circulating`);
      dilutionRisk = "low";
    } else if (circulatingPct >= 55) {
      add("token.partialCirculating", -4, `${circulatingPct.toFixed(0)}% circulating`);
      dilutionRisk = "moderate";
      sizeMultiplier = 0.9;
    } else if (circulatingPct >= 30) {
      add("token.lowCirculating", -10, `only ${circulatingPct.toFixed(0)}% circulating`);
      dilutionRisk = "high";
      sizeMultiplier = 0.75;
      warnings.push("warn.dilutionPressure");
    } else {
      // Most of the supply has yet to exist. Price discovery here happens
      // against a stream of new sellers rather than a fixed float.
      add("token.veryLowCirculating", -16, `only ${circulatingPct.toFixed(0)}% circulating`);
      dilutionRisk = "severe";
      sizeMultiplier = 0.55;
      warnings.push("warn.dilutionPressure");
    }
  }

  // FDV far above market cap says the same thing in valuation terms: most of
  // what you would be paying for has not been issued yet.
  if (fdvRatio !== null && fdvRatio >= 3 && dilutionRisk !== "severe") {
    add("token.fdvStretched", -7, `fully diluted valuation ${fdvRatio.toFixed(1)}× market cap`);
    warnings.push("warn.fdvStretched");
  }

  // Distance from the all-time high. Deep drawdowns are not automatically
  // bullish — plenty of assets never recover — but they do mark where
  // overhead supply from trapped buyers thins out.
  const drawdown = input.athChangePct < 0 ? Math.abs(input.athChangePct) : 0;
  if (drawdown >= 90) {
    add("token.deepDrawdown", -5, `${drawdown.toFixed(0)}% below its all-time high`);
    warnings.push("warn.deepDrawdown");
  } else if (drawdown <= 5 && drawdown > 0) {
    add("token.nearAth", -3, `within ${drawdown.toFixed(0)}% of its all-time high`);
  } else if (drawdown >= 40 && drawdown < 75) {
    add("token.roomToAth", 4, `${drawdown.toFixed(0)}% below its all-time high`);
  }

  return {
    available: true,
    circulatingPct,
    fdvRatio,
    dilutionRisk,
    drawdownFromAth: drawdown || null,
    score: Math.max(-25, Math.min(15, Math.round(score))),
    evidence,
    warnings: [...new Set(warnings)],
    sizeMultiplier,
  };
}
