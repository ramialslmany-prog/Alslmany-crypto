import type { Candle, Series, Timeframe } from "../src/lib/market/types";
import type { UniverseEntry } from "../src/lib/market/universe";
import { classifyMarket } from "../src/lib/analysis/regime";
import { readStructure } from "../src/lib/analysis/structure";
import {
  DEFAULT_RISK, blendedRewardRisk, buildPlan, deriveStop, effectiveRisk, positionSize,
} from "../src/lib/engine/risk";
import { rankRecommendations, recommend } from "../src/lib/engine/recommendation";
import { readLiquidity, type OrderBook } from "../src/lib/analysis/liquidity";
import type { DerivativesRead } from "../src/lib/market/derivatives";
import { describe, equal, isNull, near, ok } from "./_harness";

/** A trending series with light noise, so indicators behave realistically. */
function ramp(bars: number, start: number, driftPerBar: number, noise = 0.004): Candle[] {
  let p = start;
  const out: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const wobble = Math.sin(i / 5) * noise + Math.cos(i / 11) * noise * 0.6;
    const next = p * (1 + driftPerBar + wobble);
    out.push({
      t: i * 3600_000,
      o: p,
      h: Math.max(p, next) * (1 + noise),
      l: Math.min(p, next) * (1 - noise),
      c: next,
      v: 1000 + Math.abs(Math.sin(i / 3)) * 400,
    });
    p = next;
  }
  return out;
}

const series = (candles: Candle[], timeframe: Timeframe, source = "binance"): Series => ({
  symbol: "TEST",
  timeframe,
  candles,
  source: source as Series["source"],
  fetchedAt: Date.now(),
});

const ENTRY: UniverseEntry = {
  symbol: "TEST", id: "test", name: "Test", nameAr: "اختبار",
  sector: "smart-contract", tier: 1,
};

const bullMarket = classifyMarket({ btcCandles: ramp(260, 100, 0.006), breadth: 70, fearGreed: 55 });
const bearMarket = classifyMarket({ btcCandles: ramp(260, 300, -0.006), breadth: 20, fearGreed: 30 });

function stackOf(build: (tf: Timeframe) => Candle[], source = "binance") {
  return {
    "1d": series(build("1d"), "1d", source),
    "4h": series(build("4h"), "4h", source),
    "1h": series(build("1h"), "1h", source),
    "15m": series(build("15m"), "15m", source),
  };
}

export async function run() {
  await describe("risk — position sizing", () => {
    // 1% risk with the stop 2% away must buy a 50% position: the loss taken
    // when the stop is hit is 1% of the account either way.
    near(positionSize(100, 98, 1, 100), 50, 1e-6, "1% risk, 2% stop → 50% position");
    near(positionSize(100, 90, 1, 100), 10, 1e-6, "1% risk, 10% stop → 10% position");
    near(positionSize(100, 98, 2, 100), 100, 1e-6, "doubling risk doubles the position");
    near(positionSize(100, 99.5, 1, 25), 25, 1e-6, "the cap binds however tight the stop");
    equal(positionSize(100, 100, 1, 25), 0, "a zero-distance stop buys nothing");
    equal(positionSize(100, 105, 1, 25), 0, "a stop above entry buys nothing");
  });

  await describe("risk — haircuts only ever shrink", () => {
    const base = 1;
    ok(effectiveRisk(base, 1, 1, 100) <= base, "a perfect setup never exceeds the configured risk");
    ok(effectiveRisk(base, 0.3, 3, 20) < effectiveRisk(base, 1, 1, 90), "a hostile tape on a small cap risks less");
    ok(effectiveRisk(base, 1, 3, 90) < effectiveRisk(base, 1, 1, 90), "tier 3 risks less than tier 1");
    ok(effectiveRisk(base, 0.35, 1, 90) < effectiveRisk(base, 1, 1, 90), "a cut risk budget flows through");
    for (const budget of [0.2, 0.5, 1]) {
      for (const conf of [0, 50, 100]) {
        ok(effectiveRisk(base, budget, 1, conf) <= base, `never exceeds base (budget ${budget}, confidence ${conf})`);
      }
    }
  });

  await describe("risk — stop placement", () => {
    const candles = ramp(200, 100, 0.004);
    const price = candles[candles.length - 1].c;
    const { stop } = deriveStop(price, candles, readStructure(candles));
    ok(stop < price, "the stop sits below price");
    ok(stop > price * 0.5, "and is not absurdly far");
    const distancePct = ((price - stop) / price) * 100;
    ok(distancePct > 0.2, "it clears the noise floor rather than hugging price", `${distancePct.toFixed(2)}%`);
  });

  await describe("risk — blended reward", () => {
    near(
      blendedRewardRisk([
        { price: 0, rMultiple: 1, allocationPct: 50, basis: "x" },
        { price: 0, rMultiple: 3, allocationPct: 50, basis: "x" },
      ]),
      2, 1e-9, "two equal tranches at 1R and 3R blend to 2R",
    );
    // Weighting matters: taking most off early lowers the realistic reward.
    near(
      blendedRewardRisk([
        { price: 0, rMultiple: 1, allocationPct: 80, basis: "x" },
        { price: 0, rMultiple: 6, allocationPct: 20, basis: "x" },
      ]),
      2, 1e-9, "front-loaded tranches blend down, not up",
    );
    equal(blendedRewardRisk([]), 0, "no targets means no reward claim");
  });

  await describe("engine — a healthy uptrend", () => {
    const rec = recommend({
      entry: ENTRY,
      stack: stackOf(() => ramp(300, 100, 0.005)),
      market: bullMarket,
    })!;
    ok(rec !== null, "produces a recommendation");
    ok(["enter", "accumulate"].includes(rec.verdict), "calls it actionable", rec.verdict);
    ok(rec.score > 55, "with a bullish score", `${rec.score}`);
    ok(rec.plan !== null, "and attaches a plan");
    ok(rec.plan!.stop < rec.price, "stop below price");
    ok(rec.plan!.targets.length > 0, "with targets");
    ok(rec.plan!.targets.every((t) => t.price > rec.price), "every target above price");
    ok(rec.plan!.targets.every((t) => t.rMultiple > 0), "every target a positive R");
    near(rec.plan!.targets.reduce((s, t) => s + t.allocationPct, 0), 100, 1e-6, "tranches sum to the whole position");
    ok(rec.plan!.positionSizePct <= DEFAULT_RISK.maxPositionPct, "position respects the hard cap");
  });

  await describe("engine — a broken downtrend", () => {
    const rec = recommend({
      entry: ENTRY,
      stack: stackOf(() => ramp(300, 300, -0.005)),
      market: bearMarket,
    })!;
    ok(["avoid", "reduce", "watch"].includes(rec.verdict), "refuses to call a long", rec.verdict);
    ok(rec.score < 45, "with a bearish score", `${rec.score}`);
    ok(rec.grade === "C", "and cannot earn a grade");
    if (rec.verdict === "avoid" || rec.verdict === "reduce") {
      isNull(rec.plan, "no plan is published for something it will not buy");
    }
  });

  await describe("engine — the higher timeframe holds a veto", () => {
    // A strong short-term bounce inside a broken daily and 4h.
    const rec = recommend({
      entry: ENTRY,
      stack: {
        "1d": series(ramp(300, 300, -0.006), "1d"),
        "4h": series(ramp(300, 300, -0.005), "4h"),
        "1h": series(ramp(300, 100, 0.012), "1h"),
        "15m": series(ramp(300, 100, 0.014), "15m"),
      },
      market: bearMarket,
    })!;
    ok(rec.verdict !== "enter", "a hot 1h cannot override a broken daily", rec.verdict);
    ok(rec.warnings.includes("warn.bearMarket"), "and the bear market is stated as a warning");
  });

  await describe("engine — evidence is published for both sides", () => {
    const rec = recommend({
      entry: ENTRY,
      stack: stackOf(() => ramp(300, 100, 0.005)),
      market: bullMarket,
    })!;
    ok(rec.bullish.length > 0, "bullish factors are listed");
    ok(rec.bearish.length > 0, "bearish factors are listed even on a positive call", `${rec.bearish.length} items`);
    ok(rec.bullish.every((f) => f.weight > 0), "bullish weights are positive");
    ok(rec.bearish.every((f) => f.weight < 0), "bearish weights are negative");
    ok(rec.timeframes.length >= 2, "several timeframes contributed");
    ok(rec.bullish.every((f) => f.detail.length > 0), "every factor carries its numbers");
  });

  await describe("engine — scenarios are probabilities, not predictions", () => {
    const rec = recommend({
      entry: ENTRY,
      stack: stackOf(() => ramp(300, 100, 0.005)),
      market: bullMarket,
    })!;
    equal(rec.scenarios.length, 3, "three scenarios");
    const total = rec.scenarios.reduce((s, x) => s + x.probability, 0);
    ok(Math.abs(total - 100) <= 1, "probabilities sum to 100", `${total}`);
    ok(rec.scenarios.every((s) => s.probability > 0), "no scenario is dismissed outright");
    const bear = rec.scenarios.find((s) => s.kind === "bearish")!;
    ok(bear.probability >= 5, "a downside case is always carried", `${bear.probability}%`);
  });

  await describe("engine — determinism and guards", () => {
    const build = () => stackOf(() => ramp(300, 100, 0.005));
    const a = recommend({ entry: ENTRY, stack: build(), market: bullMarket })!;
    const b = recommend({ entry: ENTRY, stack: build(), market: bullMarket })!;
    equal(a.verdict, b.verdict, "the same candles produce the same verdict");
    equal(a.score, b.score, "and the same score");
    equal(a.plan?.stop, b.plan?.stop, "and the same stop");

    isNull(
      recommend({ entry: ENTRY, stack: { "1h": series(ramp(300, 100, 0.005), "1h") }, market: bullMarket }),
      "refuses to call anything without higher-timeframe context",
    );
    isNull(
      recommend({ entry: ENTRY, stack: { "4h": series(ramp(20, 100, 0.005), "4h") }, market: bullMarket }),
      "refuses to call anything on too few bars",
    );
  });

  await describe("engine — synthetic data is quarantined", () => {
    const rec = recommend({
      entry: ENTRY,
      stack: stackOf(() => ramp(300, 100, 0.005), "synthetic"),
      market: bullMarket,
    })!;
    ok(rec.warnings.includes("warn.syntheticData"), "flags the demo source as a warning");
    ok(rec.degraded, "marks the recommendation degraded");
    ok(rec.confidence <= 25, "and caps confidence hard", `${rec.confidence}`);
  });

  await describe("engine — a meme small-cap is warned about", () => {
    const rec = recommend({
      entry: { ...ENTRY, sector: "meme", tier: 3 },
      stack: stackOf(() => ramp(300, 100, 0.005)),
      market: bullMarket,
      btcCorrelation: 0.92,
    })!;
    ok(rec.warnings.includes("warn.memeAsset"), "flags the sector");
    ok(rec.warnings.includes("warn.smallCap"), "flags the size");
    ok(rec.warnings.includes("warn.btcCorrelated"), "flags that it is really a Bitcoin bet");
    const tier1 = recommend({ entry: ENTRY, stack: stackOf(() => ramp(300, 100, 0.005)), market: bullMarket })!;
    ok(
      (rec.plan?.riskPerTradePct ?? 9) < (tier1.plan?.riskPerTradePct ?? 0),
      "and risks less of the account than a tier 1 name",
    );
  });

  await describe("engine — crowded leverage is priced in", () => {
    const healthy = stackOf(() => ramp(300, 100, 0.005));
    const base = recommend({ entry: ENTRY, stack: healthy, market: bullMarket })!;

    const squeezed: DerivativesRead = {
      symbol: "TEST",
      funding: { ratePct: 0.3, annualizedPct: 328, averagePct: 0.28, nextFundingAt: null },
      openInterest: { amount: 100, notional: 1e6, changePct: 25 },
      positioning: { longAccountPct: 82, shortAccountPct: 18, ratio: 4.5 },
      fetchedAt: 0,
    };
    const crowded = recommend({
      entry: ENTRY, stack: healthy, market: bullMarket, derivatives: squeezed,
    })!;

    equal(crowded.derivatives.squeezeRisk, "extreme", "extreme funding is detected");
    ok(crowded.warnings.includes("warn.crowdedLongs"), "and warned about");
    ok(crowded.score < base.score, "the same chart scores lower when longs are crowded", `${crowded.score} vs ${base.score}`);
    ok(crowded.verdict !== "enter", "and it is never a full-size entry", crowded.verdict);
    ok(
      (crowded.plan?.riskPerTradePct ?? 9) < (base.plan?.riskPerTradePct ?? 0),
      "crowding shrinks the risk actually taken, not just the wording",
    );

    // No perpetual market must read as unknown, not as balanced.
    equal(base.derivatives.available, false, "no derivatives data reports unavailable");
    equal(base.derivatives.score, 0, "and contributes nothing to the score");
  });

  await describe("engine — the loss it quotes is the loss you would take", () => {
    const stack = stackOf(() => ramp(300, 100, 0.005));
    const deep: OrderBook = {
      symbol: "TEST", fetchedAt: 0,
      bids: Array.from({ length: 200 }, (_, i) => ({ price: 480 - i * 0.05, quantity: 400 })),
      asks: Array.from({ length: 200 }, (_, i) => ({ price: 480.05 + i * 0.05, quantity: 400 })),
    };
    const thin: OrderBook = {
      symbol: "TEST", fetchedAt: 0,
      bids: [{ price: 480, quantity: 0.4 }, { price: 460, quantity: 0.4 }, { price: 430, quantity: 0.4 }],
      asks: [{ price: 500, quantity: 0.4 }],
    };

    const onDeep = recommend({ entry: ENTRY, stack, market: bullMarket, liquidity: readLiquidity(deep) })!;
    const onThin = recommend({ entry: ENTRY, stack, market: bullMarket, liquidity: readLiquidity(thin) })!;

    ok(onDeep.realisticLoss !== null, "a realistic loss is computed");
    ok(
      onDeep.realisticLoss!.realisticPct > onDeep.realisticLoss!.plannedPct,
      "and always exceeds the planned loss — fees and slippage are never free",
    );
    ok(onThin.warnings.includes("warn.thinLiquidity"), "a thin book is warned about");
    ok(
      onThin.realisticLoss!.realisticPct > onDeep.realisticLoss!.realisticPct,
      "and costs more to be wrong on",
      `${onThin.realisticLoss!.realisticPct}% vs ${onDeep.realisticLoss!.realisticPct}%`,
    );
    ok(
      (onThin.plan?.positionSizePct ?? 99) <= (onDeep.plan?.positionSizePct ?? 0),
      "so the position taken on it is smaller",
    );

    // Unknown depth must never be treated as free depth.
    const unknown = recommend({ entry: ENTRY, stack, market: bullMarket })!;
    ok(unknown.realisticLoss!.slippagePct > 0, "unknown liquidity still carries an assumed cost");
  });

  await describe("engine — ranking", () => {
    const strong = recommend({ entry: ENTRY, stack: stackOf(() => ramp(300, 100, 0.005)), market: bullMarket })!;
    const weak = recommend({ entry: ENTRY, stack: stackOf(() => ramp(300, 300, -0.005)), market: bearMarket })!;
    const ranked = rankRecommendations([weak, strong]);
    equal(ranked[0].verdict, strong.verdict, "actionable calls rank above avoided ones");
  });

  await describe("engine — plan integrity", () => {
    const candles = ramp(300, 100, 0.005);
    const structure = readStructure(candles);
    const price = candles[candles.length - 1].c;
    const plan = buildPlan({
      price, candles, structure,
      riskPerTradePct: 1, minRewardRisk: 1.8, maxPositionPct: 25,
    })!;
    ok(plan !== null, "builds a plan on a healthy trend");
    ok(plan.entryLow <= plan.entryHigh, "the entry zone is ordered");
    ok(plan.entryLow > plan.stop, "the entry zone sits above the stop");
    ok(plan.stopDistancePct > 0, "the stop distance is positive");
    equal(plan.invalidationPrice, plan.stop, "invalidation is the stop, not a separate story");
    const r = plan.targets.map((t) => t.rMultiple);
    ok(r.every((x, i) => i === 0 || x > r[i - 1]), "targets ascend in R");
  });
}
