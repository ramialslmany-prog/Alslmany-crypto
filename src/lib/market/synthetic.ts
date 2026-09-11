/**
 * Last-resort synthetic market data.
 *
 * INTEGRITY RULE — read before touching this file:
 * this generator exists so the product stays explorable when every real venue
 * is unreachable (a locked-down network, an outage, a demo). Anything it
 * produces is tagged `source: "synthetic"` and `degraded: true`, and the UI is
 * required to show the demo banner whenever it sees that tag. Synthetic prices
 * must never reach a user who believes they are looking at a live market.
 *
 * The series is deterministic per symbol, so screenshots and tests are stable.
 */

import { hashString } from "@/lib/utils";
import { TF_MINUTES, type Candle, type Timeframe } from "./types";
import { UNIVERSE } from "./universe";
import type { CoinMarket, FearGreed, GlobalStats } from "./types";

/** Plausible anchor prices, only so the demo does not look absurd. */
const ANCHOR: Record<string, number> = {
  BTC: 64000, ETH: 3100, SOL: 148, BNB: 590, XRP: 0.62, ADA: 0.46,
  AVAX: 28, DOGE: 0.14, TRX: 0.13, LINK: 15.2, DOT: 6.4, MATIC: 0.58,
  LTC: 78, BCH: 420, NEAR: 5.1, UNI: 8.4, ATOM: 7.2, APT: 8.1,
  ARB: 0.82, OP: 1.9, FIL: 4.4, INJ: 22, SUI: 1.35, TIA: 7.6,
  SEI: 0.46, AAVE: 95, MKR: 2400, RUNE: 4.7, LDO: 1.8, CRV: 0.36,
  ALGO: 0.16, VET: 0.028, ICP: 9.6, HBAR: 0.078, ETC: 24, XLM: 0.11,
  FTM: 0.52, GRT: 0.18, IMX: 1.6, SAND: 0.36, AXS: 6.2, RENDER: 7.4,
  FET: 1.35, SHIB: 0.000022, PEPE: 0.0000082, WIF: 2.3,
};

/** Mulberry32 — small, fast, fully deterministic from a seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller: uniform noise alone produces unrealistically tame candles. */
function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function anchorPrice(symbol: string): number {
  const known = ANCHOR[symbol.toUpperCase()];
  if (known) return known;
  // Unknown symbol: derive something stable in a sane range.
  const h = hashString(symbol.toUpperCase());
  return 0.5 + (h % 20000) / 100;
}

/**
 * Geometric random walk with volatility clustering and a slow trend cycle —
 * enough structure that indicators and the signal engine behave realistically.
 */
export function syntheticCandles(
  symbol: string,
  timeframe: Timeframe,
  count = 300,
): Candle[] {
  const sym = symbol.toUpperCase();
  const rand = rng(hashString(`${sym}:${timeframe}`));
  const stepMs = TF_MINUTES[timeframe] * 60_000;
  const now = Date.now();

  // Always walk the same canonical path and return its tail, so asking for
  // 200 bars and asking for 300 agree on the latest price. Generating exactly
  // `count` bars instead would give each caller its own random walk, and a
  // chart and a signal card on one screen would quote different prices for
  // the same asset.
  const CANONICAL = 1000;
  const total = Math.max(count, CANONICAL);
  const start = now - total * stepMs;

  // Per-bar volatility, scaled by timeframe and by how speculative the asset is.
  const tierVol = sym === "BTC" ? 0.9 : sym === "ETH" ? 1.05 : 1.5;
  const baseVol = 0.006 * Math.sqrt(TF_MINUTES[timeframe] / 60) * tierVol;

  let price = anchorPrice(sym);
  let vol = baseVol;
  const trendPeriod = 40 + (hashString(sym) % 60);
  const trendAmp = 0.0012 * tierVol;

  const out: Candle[] = [];
  for (let i = 0; i < total; i++) {
    // Volatility clusters: today's vol pulls toward yesterday's.
    vol = vol * 0.94 + baseVol * (0.06 + 0.08 * rand());
    const trend = Math.sin((i / trendPeriod) * Math.PI * 2) * trendAmp;
    const ret = trend + gaussian(rand) * vol;

    const open = price;
    const close = Math.max(open * (1 + ret), 1e-9);
    const wick = Math.abs(gaussian(rand)) * vol * 0.9;
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);
    // Volume rises with range — the usual empirical relationship.
    const range = (high - low) / Math.max(open, 1e-9);
    const volume = (0.6 + rand() * 0.8 + range * 40) * 1000;

    out.push({
      t: start + i * stepMs,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
    });
    price = close;
  }
  return out.slice(-count);
}

export function syntheticMarkets(): CoinMarket[] {
  return UNIVERSE.map((u, i) => {
    const daily = syntheticCandles(u.symbol, "1d", 8);
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2] ?? last;
    const week = daily[0];
    const price = last.c;
    // Market cap here is illustrative only; it is never quoted as fact.
    const capBase = [3e11, 1.2e11, 6e10][i] ?? Math.max(1e8, 4e10 / (i + 1));
    return {
      id: u.id,
      symbol: u.symbol,
      name: u.name,
      image: null,
      price,
      marketCap: capBase,
      rank: i + 1,
      volume24h: capBase * 0.06,
      changePct1h: ((last.c - last.o) / last.o) * 100 * 0.2,
      changePct24h: ((price - prev.c) / prev.c) * 100,
      changePct7d: ((price - week.c) / week.c) * 100,
      high24h: last.h,
      low24h: last.l,
      ath: price * 1.9,
      athChangePct: -47,
      circulating: capBase / price,
      sparkline: syntheticCandles(u.symbol, "4h", 42).map((c) => c.c),
    };
  });
}

export function syntheticGlobal(): GlobalStats {
  const markets = syntheticMarkets();
  const total = markets.reduce((s, m) => s + m.marketCap, 0);
  return {
    totalMarketCap: total,
    totalVolume24h: total * 0.05,
    marketCapChangePct24h: markets[0]?.changePct24h ?? 0,
    btcDominance: ((markets[0]?.marketCap ?? 0) / total) * 100,
    ethDominance: ((markets[1]?.marketCap ?? 0) / total) * 100,
    activeCoins: markets.length,
  };
}

export function syntheticFearGreed(): FearGreed {
  // Anchored to the day so the demo value is stable within a session.
  const day = Math.floor(Date.now() / 86_400_000);
  const value = 30 + (hashString(String(day)) % 45);
  return {
    value,
    label: value <= 44 ? "Fear" : value <= 55 ? "Neutral" : "Greed",
    updatedAt: day * 86_400_000,
    previous: 30 + (hashString(String(day - 1)) % 45),
  };
}
