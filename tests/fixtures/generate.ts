/**
 * Generates the frozen reference fixture and golden file.
 *
 *   npx tsx tests/fixtures/generate.ts
 *
 * Run ONLY when an indicator's definition intentionally changes. Regenerating
 * to make a failing test pass defeats the purpose of having a golden file —
 * the diff is the finding.
 *
 * Candles come from a seeded generator so the fixture is byte-identical on any
 * machine, and the golden values come from `tests/reference/naive.ts`, which
 * shares no code with `src/`.
 */
import fs from "node:fs";
import path from "node:path";
import * as N from "../reference/naive";
import type { RefCandle } from "../reference/naive";

/** mulberry32 — small, fast, fully deterministic from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A price path with regimes — trending up, ranging, trending down, and a
 * volatility spike. A pure random walk would leave ADX, the squeeze detector
 * and divergence scanning essentially untested.
 */
function generateCandles(count: number, seed: number): RefCandle[] {
  const rand = rng(seed);
  const gauss = () => {
    // Box-Muller, so shocks are normally distributed rather than uniform.
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const START = Date.UTC(2024, 0, 1, 0, 0, 0);
  const HOUR = 3_600_000;
  const out: RefCandle[] = [];
  let price = 42_000;

  for (let i = 0; i < count; i++) {
    const phase = i / count;
    // Four regimes across the series.
    const drift =
      phase < 0.25 ? 0.0011 : phase < 0.5 ? 0.0 : phase < 0.75 ? -0.0009 : 0.0004;
    const vol = phase >= 0.6 && phase < 0.68 ? 0.019 : 0.0055;

    const ret = drift + gauss() * vol;
    const open = price;
    const close = open * (1 + ret);
    const wick = Math.abs(gauss()) * vol * open * 0.8;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - Math.abs(gauss()) * vol * open * 0.8;

    // Volume rises with the size of the move, as it does in a real market.
    const volume = 80 + Math.abs(ret) * 22_000 + rand() * 45;

    out.push({
      openTime: START + i * HOUR,
      open: round(open),
      high: round(Math.max(high, open, close)),
      low: round(Math.min(low, open, close)),
      close: round(close),
      volume: round(volume, 4),
    });
    price = close;
  }
  return out;
}

const round = (n: number, d = 2): number => Number(n.toFixed(d));

const CANDLE_COUNT = 600;
const SEED = 20240314;

const candles = generateCandles(CANDLE_COUNT, SEED);
const close = candles.map((c) => c.close);

/** Golden values, all computed by the INDEPENDENT naive implementations. */
const golden = {
  meta: {
    generator: "tests/reference/naive.ts",
    seed: SEED,
    count: CANDLE_COUNT,
    note: "Regenerate only when an indicator definition intentionally changes.",
  },
  sma20: N.naiveSma(close, 20),
  sma50: N.naiveSma(close, 50),
  sma200: N.naiveSma(close, 200),
  ema9: N.naiveEma(close, 9),
  ema21: N.naiveEma(close, 21),
  ema50: N.naiveEma(close, 50),
  rma14: N.naiveRma(close, 14),
  wma20: N.naiveWma(close, 20),
  rsi14: N.naiveRsi(close, 14),
  rsi7: N.naiveRsi(close, 7),
  macd: N.naiveMacd(close, 12, 26, 9),
  stdev20: N.naiveStdev(close, 20),
  bollinger: N.naiveBollinger(close, 20, 2),
  trueRange: N.naiveTrueRange(candles),
  atr14: N.naiveAtr(candles, 14),
  stochastic: N.naiveStochastic(candles, 14, 3, 3),
  obv: N.naiveObv(candles),
  vwapIntraday: N.naiveVwap(candles, true),
  vwapDaily: N.naiveVwap(candles, false),
  adx14: N.naiveAdx(candles, 14),
  ichimoku: N.naiveIchimoku(candles),
  mfi14: N.naiveMfi(candles, 14),
};

const dir = path.join(process.cwd(), "tests", "fixtures");
fs.writeFileSync(path.join(dir, "candles-1h.json"), JSON.stringify(candles) + "\n");
fs.writeFileSync(path.join(dir, "golden-indicators.json"), JSON.stringify(golden) + "\n");

const finite = (a: number[]) => a.filter(Number.isFinite).length;
console.log(`candles: ${candles.length}`);
console.log(`price range: ${Math.min(...close).toFixed(2)} → ${Math.max(...close).toFixed(2)}`);
console.log(`rsi14 finite: ${finite(golden.rsi14)}  range ${Math.min(...golden.rsi14.filter(Number.isFinite)).toFixed(2)} → ${Math.max(...golden.rsi14.filter(Number.isFinite)).toFixed(2)}`);
console.log(`sma200 finite: ${finite(golden.sma200)}`);
console.log(`adx14 finite: ${finite(golden.adx14.adx)}  max ${Math.max(...golden.adx14.adx.filter(Number.isFinite)).toFixed(2)}`);
console.log(`squeeze-relevant bandwidth finite: ${finite(golden.bollinger.bandwidth)}`);
