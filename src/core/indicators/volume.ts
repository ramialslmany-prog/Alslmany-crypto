/**
 * Volume indicators: OBV, VWAP, relative volume, and the true taker delta.
 */
import { sma } from "@/core/indicators/moving-averages";
import { type Series, filled } from "@/core/indicators/series";
import { type Timeframe, candleOpenTime } from "@/shared/time";
import type { Candle } from "@/core/types";

/**
 * On-Balance Volume: cumulative volume signed by the direction of the close.
 *
 * Its absolute level is meaningless — only its SLOPE against price matters.
 * Price making a higher high while OBV does not is the divergence this exists
 * to expose.
 */
export function obv(candles: readonly Candle[]): Series {
  const out = filled(candles.length);
  if (candles.length === 0) return out;

  let cumulative = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    cumulative += diff > 0 ? candles[i].volume : diff < 0 ? -candles[i].volume : 0;
    out[i] = cumulative;
  }
  return out;
}

/**
 * Session-anchored VWAP, reset at the start of each UTC day.
 *
 * This reset is the whole point. A VWAP accumulated from the beginning of
 * available history converges to a flat line that no longer says anything
 * about where today's average participant is positioned — and it is a very
 * easy bug to ship, because the output still looks like a plausible curve.
 *
 * For daily and weekly candles there is no intraday session, so the anchor is
 * the whole series.
 */
export function vwap(candles: readonly Candle[], timeframe: Timeframe): Series {
  const out = filled(candles.length);
  const intraday = timeframe !== "1d" && timeframe !== "1w";

  let cumPv = 0;
  let cumVol = 0;
  let currentSession = NaN;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const session = intraday ? candleOpenTime(c.openTime, "1d") : 0;

    if (session !== currentSession) {
      cumPv = 0;
      cumVol = 0;
      currentSession = session;
    }

    const typical = (c.high + c.low + c.close) / 3;
    cumPv += typical * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumPv / cumVol : typical;
  }
  return out;
}

/** Volume relative to its own trailing average. 2 means twice normal. */
export function relativeVolume(candles: readonly Candle[], period = 20): Series {
  const vols = candles.map((c) => c.volume);
  const avg = sma(vols, period);
  const out = filled(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (Number.isFinite(avg[i]) && avg[i] > 0) out[i] = vols[i] / avg[i];
  }
  return out;
}

/**
 * Per-bar taker delta: aggressive buy volume minus aggressive sell volume.
 *
 * ONLY valid when the venue reports the taker split. Callers must check
 * `capabilities.klineTakerBreakdown` first — on Bybit and OKX every bar would
 * report a delta of exactly -volume, which looks like relentless selling and
 * is in fact missing data.
 */
export function takerDelta(candles: readonly Candle[]): Series {
  return candles.map((c) => c.takerBuyBase - (c.volume - c.takerBuyBase));
}

/** Cumulative volume delta — who has been the aggressor over the window. */
export function cumulativeDelta(candles: readonly Candle[]): Series {
  const delta = takerDelta(candles);
  const out = filled(candles.length);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += delta[i];
    out[i] = sum;
  }
  return out;
}

/**
 * Money Flow Index — RSI weighted by volume. A 14-period reading above 80 with
 * price stalling is distribution.
 */
export function mfi(candles: readonly Candle[], period = 14): Series {
  const out = filled(candles.length);
  if (candles.length <= period) return out;

  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);

  for (let i = period; i < candles.length; i++) {
    let positive = 0;
    let negative = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = typical[j] * candles[j].volume;
      if (typical[j] > typical[j - 1]) positive += flow;
      else if (typical[j] < typical[j - 1]) negative += flow;
    }
    if (negative === 0) {
      out[i] = positive === 0 ? 50 : 100;
      continue;
    }
    out[i] = 100 - 100 / (1 + positive / negative);
  }
  return out;
}
