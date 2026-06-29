import { NextResponse } from "next/server";
import { fetchCandles, type Interval, type Candle } from "@/lib/candles";
import { analyzeTimeframe } from "@/lib/signal-engine";

/**
 * Walk-forward backtest of the live spot strategy (buy-the-dip in an uptrend
 * with staged take-profit: TP1→breakeven, TP2→trail to TP1, TP3→full exit).
 * Steps bar-by-bar over real historical klines, opens at the same entry rule
 * the autonomous trader uses, then simulates the exact exit management. Honest:
 * one position at a time, no look-ahead — each decision uses only past candles.
 */
export const dynamic = "force-dynamic";

const TF: Record<string, Interval> = { scalp: "15m", day: "1h", swing: "4h" };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface BTrade {
  entryIdx: number;
  entry: number;
  exit: number;
  retPct: number;
  bars: number;
  outcome: "tp3" | "trail" | "breakeven" | "stop" | "timeout";
}

/** Tunable strategy knobs — defaults reproduce the original live behavior exactly. */
interface BTOpts {
  minBias: number; // minimum confluence bias to enter
  requireUp: boolean; // require a confirmed uptrend (not just "not down")
  requireVol: boolean; // require volume-confirmed entry bar
  tp1Frac: number; // fraction scaled out at TP1 (rest runs)
  tp2Frac: number; // fraction scaled out at TP2 (rest runs to TP3/stop)
}
const DEFAULTS: BTOpts = { minBias: 1.0, requireUp: false, requireVol: false, tp1Frac: 0, tp2Frac: 0 };

function runBacktest(c: Candle[], opt: BTOpts = DEFAULTS) {
  const WARMUP = 60; // enough for EMA50/MACD/RSI/BB/ATR; EMA200 fills in later
  const MAX_HOLD = 120; // bars
  const trades: BTrade[] = [];
  let i = WARMUP;

  while (i < c.length - 2) {
    const a = analyzeTimeframe("1h", c.slice(0, i + 1));
    // Buy a pullback inside net-bullish confluence: positive bias, RSI in the
    // dip zone (not overbought), price not pinned to the upper band.
    const dipZone = a.rsi >= 40 && a.rsi <= 62 && a.bbPctB <= 0.7;
    const trendOk = opt.requireUp ? a.trend === "up" : a.trend !== "down";
    const volOk = opt.requireVol ? a.volConfirmed : true;
    const enter = a.bias >= opt.minBias && trendOk && dipZone && volOk;
    if (!enter) {
      i++;
      continue;
    }

    const entry = c[i].c;
    const atrPct = (a.atr / entry) * 100;
    const volPct = clamp(atrPct, 0.5, 5);
    const stopPct = clamp(volPct * 1.5, 2, 6);
    const risk = (stopPct / 100) * entry;
    const targets = [entry + 1.5 * risk, entry + 2.5 * risk, entry + 4 * risk];
    let stop = entry - risk;
    let hit = 0;

    // Simulate forward bars with the staged exit logic. Position starts at full
    // size; optional partial scale-outs at TP1/TP2 lock in gains, rest trails.
    let j = i + 1;
    let remaining = 1;
    let realized = 0; // size-weighted return fraction already booked
    let outcome: BTrade["outcome"] = "timeout";
    for (; j < c.length && j - i <= MAX_HOLD; j++) {
      const { h, l } = c[j];
      if (l <= stop) {
        realized += remaining * ((stop - entry) / entry);
        remaining = 0;
        outcome = hit >= 2 ? "trail" : hit >= 1 ? "breakeven" : "stop";
        break;
      }
      if (h >= targets[2]) {
        realized += remaining * ((targets[2] - entry) / entry);
        remaining = 0;
        outcome = "tp3";
        break;
      }
      if (h >= targets[1] && hit < 2) {
        const take = Math.min(remaining, opt.tp2Frac);
        realized += take * ((targets[1] - entry) / entry);
        remaining -= take;
        hit = 2;
        stop = targets[0]; // trail to TP1
      }
      if (h >= targets[0] && hit < 1) {
        const take = Math.min(remaining, opt.tp1Frac);
        realized += take * ((targets[0] - entry) / entry);
        remaining -= take;
        hit = 1;
        stop = entry; // breakeven
      }
    }
    const exitIdx = Math.min(j, c.length - 1);
    if (remaining > 0) realized += remaining * ((c[exitIdx].c - entry) / entry); // timeout / leftover

    trades.push({
      entryIdx: i,
      entry,
      exit: entry * (1 + realized),
      retPct: realized * 100,
      bars: exitIdx - i,
      outcome,
    });
    i = j + 1; // no overlapping positions
  }

  const wins = trades.filter((t) => t.retPct > 0.05);
  const losses = trades.filter((t) => t.retPct < -0.05);
  const decided = wins.length + losses.length;
  const gw = wins.reduce((s, t) => s + t.retPct, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.retPct, 0));
  let equity = 100;
  const curve = [100];
  for (const t of trades) {
    equity *= 1 + t.retPct / 100;
    curve.push(equity);
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: decided ? (wins.length / decided) * 100 : 0,
    totalReturnPct: equity - 100,
    avgPct: trades.length ? trades.reduce((s, t) => s + t.retPct, 0) / trades.length : 0,
    profitFactor: gl > 0 ? Math.min(gw / gl, 99) : gw > 0 ? 99 : 0,
    avgBars: trades.length ? Math.round(trades.reduce((s, t) => s + t.bars, 0) / trades.length) : 0,
    bestPct: trades.length ? Math.max(...trades.map((t) => t.retPct)) : 0,
    worstPct: trades.length ? Math.min(...trades.map((t) => t.retPct)) : 0,
    equityCurve: curve,
    recent: trades.slice(-12).reverse(),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "BTC").toUpperCase();
  const style = searchParams.get("style") ?? "day";
  const interval = TF[style] ?? "1h";

  const { source, candles } = await fetchCandles(symbol, interval, 1000);
  if (candles.length < 90) {
    return NextResponse.json({ symbol, interval, source, error: "not-enough-data" }, { status: 200 });
  }
  // Optional tuning knobs (research/validation). Absent → original live behavior.
  const num = (k: string, d: number) => { const v = parseFloat(searchParams.get(k) ?? ""); return Number.isFinite(v) ? v : d; };
  const opt: BTOpts = {
    minBias: num("minBias", DEFAULTS.minBias),
    requireUp: searchParams.get("requireUp") === "1",
    requireVol: searchParams.get("requireVol") === "1",
    tp1Frac: num("tp1Frac", DEFAULTS.tp1Frac),
    tp2Frac: num("tp2Frac", DEFAULTS.tp2Frac),
  };
  const result = runBacktest(candles, opt);
  const fromTs = candles[60].t;
  const toTs = candles[candles.length - 1].t;
  return NextResponse.json(
    { symbol, interval, style, source, fromTs, toTs, bars: candles.length, ...result },
    { headers: { "cache-control": "no-store" } }
  );
}
