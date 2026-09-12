import "server-only";
import { loadSeries } from "@/lib/market/feed";
import { atr, last } from "@/lib/analysis/indicators";
import { scanMarket, analyzeSymbol } from "@/lib/engine/scan";
import { lookupSymbol } from "@/lib/market/universe";
import { notifyTick } from "@/lib/notify/telegram";
import { PaperBroker } from "./broker";
import { closePosition, considerEntries, manage, type Quote } from "./engine";
import { loadState, saveState } from "./store";
import { DEFAULT_BOT_CONFIG, type BotConfig, type BotState, type Position } from "./types";

/**
 * One tick of the bot.
 *
 * Order matters and is the same every time: manage what is already open before
 * looking for anything new. Hunting for entries while an open position is
 * sitting on its stop is how a book quietly grows past its own limits.
 */

/** The timeframe positions are managed on. */
const MANAGE_TF = "1h" as const;

export type TickResult = {
  state: BotState;
  opened: Position[];
  closed: Position[];
  refused: { symbol: string; reason: string }[];
  marketRegime: string;
  riskBudget: number;
  notified: number;
  durable: boolean;
  degraded: boolean;
};

export async function runTick(config: BotConfig = DEFAULT_BOT_CONFIG): Promise<TickResult> {
  const broker = new PaperBroker();
  let state = await loadState();

  // ── 1. Fresh bars for everything currently held ──
  const symbols = [...new Set(state.positions.map((p) => p.symbol))];
  const quotes: Quote[] = [];
  for (const symbol of symbols) {
    try {
      const series = await loadSeries(symbol, MANAGE_TF, 120);
      const candles = series.data.candles;
      const bar = candles[candles.length - 1];
      if (!bar) continue;
      // Never manage a real position against demo prices.
      if (series.data.source === "synthetic") continue;

      // A fresh read on the asset we are holding. Without it the bot can only
      // ask "has price hit my stop?"; with it, it can ask whether the reason
      // for being in the trade is still true — which is where most of the
      // improvement in average loss comes from.
      const entry = lookupSymbol(symbol);
      let analysis = null;
      let marketLabel;
      if (entry) {
        try {
          const read = await analyzeSymbol(entry);
          analysis = read.recommendation;
          marketLabel = read.market.label;
        } catch {
          // Analysis is an enhancement, never a prerequisite. Without it the
          // position falls back to pure price management rather than stalling.
        }
      }

      quotes.push({
        symbol,
        bar,
        atr: last(atr(candles, 14)) ?? bar.c * 0.02,
        analysis,
        marketLabel,
      });
    } catch {
      // No bar, no action — the position is left exactly as it was.
    }
  }

  const before = new Set(state.positions.map((p) => p.id));
  state = await manage(state, quotes, config, broker);
  const closed = state.closed.filter((p) => before.has(p.id) && p.closedAt);

  // ── 2. The market, and whether it still permits risk ──
  const scan = await scanMarket({ maxTier: 2, limit: 40 });

  // A regime that has turned outright hostile closes the book rather than
  // waiting for each individual stop to be hit one at a time.
  const hostile = scan.market.label === "bear" && scan.market.leader.score < -45;
  const forcedClosures: Position[] = [];
  if (hostile && state.positions.length > 0) {
    const remaining: Position[] = [];
    for (const position of state.positions) {
      const quote = quotes.find((q) => q.symbol === position.symbol);
      if (!quote) {
        remaining.push(position);
        continue;
      }
      const result = await closePosition(position, quote.bar.c, "regime", broker, quote.bar.t);
      forcedClosures.push(result.position);
      state = { ...state, events: [...state.events, result.event].slice(-500) };
    }
    state = {
      ...state,
      positions: remaining,
      closed: [...state.closed, ...forcedClosures],
    };
  }

  // ── 3. New entries, only if the regime allows any at all ──
  let opened: Position[] = [];
  let refused: { symbol: string; reason: string }[] = [];
  if (!hostile && !scan.degraded) {
    const result = await considerEntries(state, scan.recommendations, config, broker);
    state = result.state;
    opened = result.opened;
    refused = result.refused;
  } else {
    refused = scan.recommendations
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, reason: hostile ? "regime.hostile" : "data.notLive" }));
  }

  const allClosed = [...closed, ...forcedClosures];
  const durable = await saveState(state);
  const notified = await notifyTick(opened, allClosed, state.events);

  return {
    state,
    opened,
    closed: allClosed,
    refused,
    marketRegime: scan.market.label,
    riskBudget: scan.market.riskBudget,
    notified,
    durable,
    degraded: scan.degraded,
  };
}
