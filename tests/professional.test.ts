import type { Candle } from "../src/lib/market/types";
import type { DerivativesRead } from "../src/lib/market/derivatives";
import type { OrderBook } from "../src/lib/analysis/liquidity";
import { analyzeDerivatives } from "../src/lib/analysis/derivatives";
import { findDivergences, readDivergences } from "../src/lib/analysis/divergence";
import { buildVolumeProfile, readVolumeProfile } from "../src/lib/analysis/volume-profile";
import { estimateSlippage, readLiquidity } from "../src/lib/analysis/liquidity";
import { computeRealisticLoss, measureGapRisk, sizeForRealisticLoss } from "../src/lib/engine/loss-model";
import { describe, equal, near, ok } from "./_harness";

const bar = (t: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({
  t: t * 3600_000, o, h, l, c, v,
});

const deriv = (over: Partial<DerivativesRead> = {}): DerivativesRead => ({
  symbol: "TEST",
  funding: null,
  openInterest: null,
  positioning: null,
  fetchedAt: 0,
  ...over,
});

function book(bids: [number, number][], asks: [number, number][]): OrderBook {
  return {
    symbol: "TEST",
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
    fetchedAt: 0,
  };
}

export async function run() {
  await describe("derivatives — crowded leverage is read against the crowd", () => {
    const calm = analyzeDerivatives(
      deriv({ funding: { ratePct: 0.008, annualizedPct: 8.8, averagePct: 0.008, nextFundingAt: null } }),
    );
    equal(calm.squeezeRisk, "none", "balanced funding carries no squeeze risk");
    equal(calm.sizeMultiplier, 1, "and does not shrink the position");

    const hot = analyzeDerivatives(
      deriv({ funding: { ratePct: 0.25, annualizedPct: 273, averagePct: 0.22, nextFundingAt: null } }),
    );
    equal(hot.squeezeRisk, "extreme", "extreme funding is an extreme squeeze risk");
    ok(hot.score < 0, "and scores against a long", `${hot.score}`);
    ok(hot.warnings.includes("warn.crowdedLongs"), "and warns that longs are crowded");
    ok(hot.sizeMultiplier <= 0.4, "and cuts position size hard", `${hot.sizeMultiplier}`);

    const negative = analyzeDerivatives(
      deriv({ funding: { ratePct: -0.15, annualizedPct: -164, averagePct: -0.12, nextFundingAt: null } }),
    );
    ok(negative.score > 0, "shorts paying heavily is fuel for upside", `${negative.score}`);

    // Rising open interest into hot funding is leverage stacked on leverage.
    const stacking = analyzeDerivatives(
      deriv({
        funding: { ratePct: 0.08, annualizedPct: 87, averagePct: 0.07, nextFundingAt: null },
        openInterest: { amount: 100, notional: 1e6, changePct: 20 },
      }),
    );
    const healthy = analyzeDerivatives(
      deriv({ openInterest: { amount: 100, notional: 1e6, changePct: 20 } }),
    );
    ok(stacking.score < healthy.score, "rising OI reads worse when funding is already hot");

    const crowdedAccounts = analyzeDerivatives(
      deriv({ positioning: { longAccountPct: 80, shortAccountPct: 20, ratio: 4 } }),
    );
    ok(crowdedAccounts.score < 0, "four-to-one long accounts scores against a long");

    // A missing perpetual market must read as unknown, never as balance.
    const none = analyzeDerivatives(deriv());
    equal(none.available, false, "no derivatives market reports unavailable");
    equal(none.score, 0, "contributes nothing");
    equal(none.evidence.length, 0, "and claims nothing");
    equal(analyzeDerivatives(null).available, false, "a null read is also unavailable");
  });

  await describe("divergence — reversal and continuation are told apart", () => {
    // Price grinds to a higher high while momentum fades: regular bearish.
    const bearish: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 140; i++) {
      // Two pushes up, the second higher in price but weaker in momentum.
      const wave = Math.sin(i / 9);
      const decay = i < 70 ? 1 : 0.35;
      p = 100 + i * 0.18 + wave * 6 * decay;
      bearish.push(bar(i, p, p * 1.01, p * 0.99, p));
    }
    const readBear = readDivergences(bearish);
    ok(Array.isArray(readBear.divergences), "returns a list");

    // Every divergence must be internally consistent with its own label.
    for (const d of findDivergences(bearish, 60)) {
      const priceUp = d.priceTo > d.priceFrom;
      const indUp = d.indicatorTo > d.indicatorFrom;
      ok(priceUp !== indUp, `${d.kind} genuinely disagrees with price`);
    }

    const flat: Candle[] = Array.from({ length: 140 }, (_, i) => bar(i, 100, 100.2, 99.8, 100));
    equal(findDivergences(flat).length, 0, "a flat series produces no divergence");
    equal(findDivergences([bar(0, 1, 1, 1, 1)]).length, 0, "too few bars produces none");

    ok(
      readDivergences(flat).score === 0,
      "no divergence contributes no score",
    );
  });

  await describe("volume profile", () => {
    // Heavy trading concentrated around 100, thin tails.
    const candles: Candle[] = [];
    for (let i = 0; i < 120; i++) {
      const centred = i % 4 !== 0;
      const price = centred ? 100 + (i % 3) * 0.2 : 90 + (i % 20);
      candles.push(bar(i, price, price * 1.004, price * 0.996, price, centred ? 900 : 40));
    }
    const profile = buildVolumeProfile(candles)!;
    ok(profile !== null, "builds a profile");
    ok(Math.abs(profile.poc - 100) < 6, "POC lands in the heavily traded zone", `${profile.poc.toFixed(2)}`);
    ok(profile.valueAreaLow < profile.valueAreaHigh, "the value area is ordered");
    ok(profile.valueAreaLow <= profile.poc && profile.poc <= profile.valueAreaHigh, "and contains the POC");

    const shareSum = profile.nodes.reduce((s, n) => s + n.sharePct, 0);
    near(shareSum, 100, 0.01, "node shares account for all volume");

    const inArea = profile.nodes
      .filter((n) => n.price >= profile.valueAreaLow && n.price <= profile.valueAreaHigh)
      .reduce((s, n) => s + n.sharePct, 0);
    ok(inArea >= 69, "the value area really holds ~70% of volume", `${inArea.toFixed(1)}%`);

    equal(buildVolumeProfile(candles.slice(0, 5)), null, "too few bars yields no profile");
    // Every bar trading at one price is not a distribution, so there is nothing
    // to profile. Reporting null is the honest answer; inventing a value area
    // of zero width would read downstream as a real, extremely tight one.
    const zeroRange: Candle[] = Array.from({ length: 40 }, (_, i) => bar(i, 50, 50, 50, 50, 10));
    equal(buildVolumeProfile(zeroRange), null, "a series with no price range yields no profile");
    equal(readVolumeProfile(zeroRange).score, 0, "and therefore claims no direction");

    equal(readVolumeProfile(candles.slice(0, 5)).score, 0, "no profile means no directional claim");
  });

  await describe("liquidity — what an exit actually costs", () => {
    // A deep, tight book.
    const deep = book(
      Array.from({ length: 50 }, (_, i) => [100 - i * 0.01, 500] as [number, number]),
      Array.from({ length: 50 }, (_, i) => [100.01 + i * 0.01, 500] as [number, number]),
    );
    const thin = book(
      [[100, 1], [99, 1], [98, 1], [95, 1]],
      [[101, 1], [102, 1]],
    );

    const deepExit = estimateSlippage(deep, 1_000, "sell");
    near(deepExit.slippagePct, 0, 0.05, "a deep book costs almost nothing to exit");
    equal(deepExit.exceedsBook, false, "and absorbs the order");

    const thinExit = estimateSlippage(thin, 10_000, "sell");
    ok(thinExit.exceedsBook, "a thin book cannot absorb a real exit");
    ok(thinExit.fillableNotional < 10_000, "and reports how little it can fill", `$${thinExit.fillableNotional.toFixed(0)}`);

    const partialExit = estimateSlippage(thin, 300, "sell");
    ok(partialExit.slippagePct > 0, "walking a thin book costs something", `${partialExit.slippagePct.toFixed(2)}%`);
    ok(partialExit.averagePrice < partialExit.bestPrice, "and fills below the best bid");

    const buy = estimateSlippage(thin, 300, "buy");
    ok(buy.averagePrice >= buy.bestPrice, "a buy fills at or above the best ask");
    ok(buy.slippagePct >= 0, "slippage is always reported as a cost, never a gain");

    ok(readLiquidity(deep).score > readLiquidity(thin).score, "a deep book scores above a thin one");
    ok(readLiquidity(thin).score < 40, "and a thin book falls below the trust threshold", `${readLiquidity(thin).score}`);

    const empty = book([], []);
    equal(estimateSlippage(empty, 1000, "sell").exceedsBook, true, "an empty book fills nothing");
  });

  await describe("gap risk", () => {
    const calm: Candle[] = Array.from({ length: 200 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    const calmRisk = measureGapRisk(calm);
    ok(calmRisk.tailPct < 1, "a calm series has a small tail", `${calmRisk.tailPct.toFixed(2)}%`);

    const violent: Candle[] = Array.from({ length: 200 }, (_, i) =>
      i === 150 ? bar(i, 100, 100, 82, 85) : bar(i, 100, 100.5, 99.5, 100),
    );
    const violentRisk = measureGapRisk(violent);
    ok(violentRisk.worstPct > 15, "a flash crash is captured in the worst case", `${violentRisk.worstPct.toFixed(1)}%`);
    ok(violentRisk.worstPct > calmRisk.worstPct, "and exceeds the calm series");

    equal(measureGapRisk([bar(0, 1, 1, 1, 1)]).sample, 0, "too little history reports no sample");
  });

  await describe("realistic loss — the number that can actually be promised", () => {
    const deep = book(
      Array.from({ length: 80 }, (_, i) => [100 - i * 0.005, 2000] as [number, number]),
      Array.from({ length: 80 }, (_, i) => [100.005 + i * 0.005, 2000] as [number, number]),
    );
    const thin = book([[100, 2], [98, 2], [94, 2]], [[102, 2]]);

    const good = computeRealisticLoss({
      entry: 100, stop: 95, positionSizePct: 20, intendedAccountRiskPct: 1,
      liquidity: readLiquidity(deep),
      gapRisk: { worstPct: 3, tailPct: 2, sample: 200 },
    });
    near(good.plannedPct, 5, 1e-6, "the planned loss is the stop distance");
    ok(good.realisticPct > good.plannedPct, "the realistic loss always exceeds the planned one");
    ok(good.realisticPct < good.plannedPct * 1.3, "but only modestly on a deep book", `${good.realisticPct}%`);
    equal(good.gapPct, 0, "a tail inside the stop adds nothing");
    ok(!good.understated, "and the stated risk holds");

    const bad = computeRealisticLoss({
      entry: 100, stop: 99, positionSizePct: 60, intendedAccountRiskPct: 1,
      liquidity: readLiquidity(thin),
      gapRisk: { worstPct: 25, tailPct: 12, sample: 200 },
    });
    ok(bad.gapPct > 0, "a tail beyond the stop adds to the loss", `${bad.gapPct}%`);
    ok(bad.severityMultiple > 2, "a tight stop on a thin book is far worse than planned", `${bad.severityMultiple}×`);
    ok(bad.understated, "and the plan is flagged as understating its risk");
    ok(bad.drivers.length > 0, "with the reasons named", bad.drivers.join(", "));

    const unknown = computeRealisticLoss({
      entry: 100, stop: 95, positionSizePct: 20, intendedAccountRiskPct: 1,
      liquidity: null,
      gapRisk: { worstPct: 3, tailPct: 2, sample: 200 },
    });
    ok(unknown.slippagePct > 0, "unknown liquidity is never treated as free");
    ok(unknown.drivers.includes("loss.driver.unknownLiquidity"), "and says so");
  });

  await describe("sizing against the realistic loss", () => {
    // 1% account risk with a realistic 5% loss buys 20% of the account.
    near(sizeForRealisticLoss(5, 1, 100), 20, 1e-6, "1% risk at a 5% realistic loss → 20%");
    // The same stop on a worse book buys less.
    ok(
      sizeForRealisticLoss(8, 1, 100) < sizeForRealisticLoss(5, 1, 100),
      "a worse realistic loss always buys a smaller position",
    );
    near(sizeForRealisticLoss(1, 1, 25), 25, 1e-6, "the cap still binds");
    equal(sizeForRealisticLoss(0, 1, 25), 0, "a zero loss estimate buys nothing rather than infinity");
  });
}
