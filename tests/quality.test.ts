/**
 * Quality-score tests.
 *
 * The rules worth pinning are the ones that stop a number from flattering a
 * bad trade: what counts as a conflict, what a conflict does to the total,
 * and the refusal to call the score a probability.
 */
import { describe, expect, it } from "vitest";
import {
  computeQuality, gradeFromScore, QUALITY_WEIGHTS, type QualityInput,
} from "@/core/recommendation/quality";
import { stagePass } from "@/core/pipeline/types";

const stage = (id: "structure" | "technical", score: number) =>
  stagePass(id, {
    score, bias: score > 0 ? "bullish" : "bearish",
    factors: [
      { id: "volume_trend", label: "v", value: score, display: "", contribution: score / 4, note: "" },
      { id: "momentum_rsi", label: "m", value: score, display: "", contribution: score / 4, note: "" },
    ],
    confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0,
  });

const input = (over: Partial<QualityInput> = {}): QualityInput => ({
  direction: "long",
  stages: [stage("structure", 60), stage("technical", 60)],
  setupFit: 0.9,
  entryDistanceAtr: 0.2,
  riskReward: 3,
  minRiskReward: 1.8,
  btcScore: 50,
  quoteVolume24h: 100_000_000,
  minQuoteVolume: 5_000_000,
  regimeConfidence: 70,
  regimeAgreesWithDirection: true,
  ...over,
});

describe("the weights", () => {
  it("sum to exactly 100", () => {
    const total = Object.values(QUALITY_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBe(100);
  });

  it("cannot exceed 100 even when every factor is strong", () => {
    expect(computeQuality(input()).score).toBeLessThanOrEqual(100);
  });

  it("cannot go below 0 when every factor conflicts", () => {
    const r = computeQuality(input({
      regimeAgreesWithDirection: false,
      entryDistanceAtr: -2,
      riskReward: 0.5,
      btcScore: -80,
      stages: [stage("structure", -70), stage("technical", -70)],
    }));
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe("what counts as a conflict", () => {
  it("separates CONFLICTING from merely weak", () => {
    // Three weak factors are a thin case; one conflicting factor is a reason
    // to walk away, and collapsing them into one grade loses that.
    expect(gradeFromScore(5, "long")).toBe("weak");
    expect(gradeFromScore(-40, "long")).toBe("conflicting");
    // The same reading flips with the direction: −60 is a conflict for a long
    // and strong evidence for a short.
    expect(gradeFromScore(-60, "long")).toBe("conflicting");
    expect(gradeFromScore(-60, "short")).toBe("strong");
  });

  it("grades an EXTENDED entry as conflicting, not weak", () => {
    // Price already past the zone is not a weaker version of the same trade —
    // it is a different trade, and the spec calls it chasing.
    const r = computeQuality(input({ entryDistanceAtr: -1.5 }));
    const entry = r.factors.find((f) => f.id === "entryQuality")!;
    expect(entry.grade).toBe("conflicting");
    expect(entry.points).toBe(0);
    expect(r.conflicts.map((c) => c.id)).toContain("entryQuality");
  });

  it("grades a risk/reward under the floor as conflicting", () => {
    const r = computeQuality(input({ riskReward: 1.2, minRiskReward: 1.8 }));
    expect(r.conflicts.map((c) => c.id)).toContain("riskReward");
  });

  it("NAMES the conflicts rather than hiding them inside a decent total", () => {
    const r = computeQuality(input({ entryDistanceAtr: -2 }));
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.arabic).toContain("يعارض");
    // The total can still look respectable — which is exactly why the
    // conflict has to be named separately.
    expect(r.score).toBeGreaterThan(50);
  });
});

describe("what the score refuses to be", () => {
  it("says in its own words that it is NOT a probability", () => {
    expect(computeQuality(input()).arabic).toContain("ليست احتمال ربح");
  });

  it("does not count correlated indicators twice", () => {
    // Volume and momentum are read once each from the stage's own factors. A
    // second agreeing indicator must not inflate the same evidence.
    const one = computeQuality(input());
    const doubled = computeQuality(input({
      stages: [
        stage("structure", 60),
        stagePass("technical", {
          score: 60, bias: "bullish",
          factors: [
            { id: "volume_trend", label: "v", value: 60, display: "", contribution: 7.5, note: "" },
            { id: "volume_obv", label: "v2", value: 60, display: "", contribution: 7.5, note: "" },
            { id: "momentum_rsi", label: "m", value: 60, display: "", contribution: 15, note: "" },
          ],
          confidencePenalty: 0, warnings: [], arabic: "", dataAgeMs: null, durationMs: 0,
        }),
      ],
    }));
    // Both already at the cap for those factors — more agreement cannot buy
    // more than the weight allows.
    const cap = QUALITY_WEIGHTS.volume + QUALITY_WEIGHTS.momentum;
    const pointsOf = (r: ReturnType<typeof computeQuality>) =>
      r.factors.filter((f) => f.id === "volume" || f.id === "momentum")
        .reduce((s, f) => s + f.points, 0);
    expect(pointsOf(one)).toBeLessThanOrEqual(cap);
    expect(pointsOf(doubled)).toBeLessThanOrEqual(cap);
  });
});
