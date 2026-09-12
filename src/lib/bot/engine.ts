import type { Candle } from "@/lib/market/types";
import type { Recommendation } from "@/lib/engine/recommendation";
import { hashString } from "@/lib/utils";
import { PaperBroker, rMultipleOf, type Broker } from "./broker";
import { captureThesis, checkThesis, shouldRun, trailMultiple } from "./thesis";
import type { RegimeLabel } from "@/lib/analysis/regime";
import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type BotState,
  type Position,
  type PositionEvent,
} from "./types";

/**
 * The trading engine.
 *
 * The whole point of automating this is that the rules execute the same way on
 * the trade that is working and the trade that is not. Every decision below is
 * mechanical: nothing consults a feeling, and nothing may widen a stop.
 */

/** A bar's worth of market for one symbol. */
export type Quote = {
  symbol: string;
  bar: Candle;
  /** ATR on the managing timeframe, for the trailing stop. */
  atr: number;
  /**
   * A fresh read on the same asset, when one is available.
   *
   * Without it the bot can only ask "has price hit my stop?". With it, it can
   * ask the far more useful question: "is the reason I entered still true?"
   */
  analysis?: Recommendation | null;
  /** The wider market's regime at this tick. */
  marketLabel?: RegimeLabel;
};

function positionId(symbol: string, at: number): string {
  return `${symbol}-${at.toString(36)}-${hashString(`${symbol}${at}`).toString(36).slice(0, 4)}`;
}

/**
 * Recompute realised results from the fills.
 *
 * Both figures are weighted by the share of the original position each exit
 * released, so a 40% tranche taken at 2R contributes 0.8R and not 2R. Treating
 * partial exits as though they were whole is the most common way a paper
 * track record inflates itself.
 */
function recompute(position: Position): Position {
  const exits = position.fills.filter((f) => f.reason !== "entry");
  const r = exits.reduce((s, f) => s + f.fraction * f.rMultiple, 0);
  const pct = exits.reduce(
    (s, f) => s + f.fraction * ((f.price - position.entry) / position.entry) * 100,
    0,
  );
  return { ...position, realizedR: Number(r.toFixed(4)), realizedPct: Number(pct.toFixed(4)) };
}

// ── Entry ────────────────────────────────────────────────────────────────

export type EntryRefusal = { ok: false; reason: string };
export type EntryApproval = { ok: true };

/**
 * Portfolio-level gate, checked before any single idea is judged on merit.
 * These limits exist because five uncorrelated-looking altcoin longs in a
 * risk-off tape are one Bitcoin bet wearing five hats, and sizing them as
 * though they were independent is how an account gets taken apart in one move.
 */
export function canOpen(
  state: BotState,
  rec: Recommendation,
  config: BotConfig = DEFAULT_BOT_CONFIG,
): EntryApproval | EntryRefusal {
  if (rec.verdict !== "enter") return { ok: false, reason: "verdict.notActionable" };
  if (!rec.plan) return { ok: false, reason: "plan.missing" };
  if (!config.allowedGrades.includes(rec.grade)) return { ok: false, reason: "grade.belowBar" };
  if (rec.confidence < config.minConfidence) return { ok: false, reason: "confidence.tooLow" };
  if (rec.plan.rewardRisk < config.minRewardRisk) return { ok: false, reason: "reward.tooThin" };
  if (rec.degraded) return { ok: false, reason: "data.notLive" };

  const open = state.positions.filter((p) => p.status === "open");
  if (open.length >= config.maxPositions) return { ok: false, reason: "portfolio.full" };
  if (open.some((p) => p.symbol === rec.symbol)) return { ok: false, reason: "position.alreadyOpen" };

  const inSector = open.filter((p) => p.sector === rec.sector).length;
  if (inSector >= config.maxPerSector) return { ok: false, reason: "portfolio.sectorConcentration" };

  if (rec.plan.stop >= rec.price) return { ok: false, reason: "plan.stopAboveEntry" };

  // ── The professional gates ──

  // Entering a crowded leveraged tape is the most reliable way to be caught in
  // a cascade. The chart can look perfect and still be a trap.
  const squeezeRank = { none: 0, elevated: 1, high: 2, extreme: 3 } as const;
  if (squeezeRank[rec.derivatives.squeezeRisk] > squeezeRank[config.maxSqueezeRisk]) {
    return { ok: false, reason: "deriv.squeezeRisk" };
  }

  // What you cannot exit, you cannot risk-manage. A stop on a book that cannot
  // fill it is a number on a screen, not a limit on the loss.
  if (rec.liquidity && rec.liquidity.score < config.minLiquidityScore) {
    return { ok: false, reason: "liquidity.tooThin" };
  }

  // If the honest loss overshoots the intended risk even after re-sizing, the
  // trade cannot be taken at a size that respects the risk budget.
  if (config.rejectUnderstatedRisk && rec.realisticLoss?.understated) {
    return { ok: false, reason: "loss.understated" };
  }

  // Two independent oscillators calling a reversal is not something to buy into.
  if (rec.divergence.confirmed && rec.divergence.score < 0) {
    return { ok: false, reason: "divergence.bearish" };
  }

  return { ok: true };
}

export async function openPosition(
  rec: Recommendation,
  config: BotConfig = DEFAULT_BOT_CONFIG,
  broker: Broker = new PaperBroker(),
  now = Date.now(),
): Promise<{ position: Position; event: PositionEvent } | null> {
  if (!rec.plan) return null;
  const plan = rec.plan;

  const fill = await broker.buy(rec.symbol, rec.price, plan.positionSizePct, now);

  // The stop is anchored to the price we actually filled at, not the price we
  // hoped for. Anchoring to the quote would quietly understate real risk.
  const entry = fill.price;
  const stopDistance = plan.reference - plan.stop;
  const initialStop = entry - stopDistance;

  const position: Position = {
    id: positionId(rec.symbol, now),
    symbol: rec.symbol,
    sector: rec.sector,
    tier: rec.tier,
    openedAt: now,
    entry,
    initialStop,
    stop: initialStop,
    targets: plan.targets,
    remaining: 1,
    targetsHit: 0,
    sizePct: plan.positionSizePct,
    riskPct: plan.riskPerTradePct,
    thesis: {
      verdict: rec.verdict,
      grade: rec.grade,
      score: rec.score,
      confidence: rec.confidence,
      horizon: rec.horizon,
      bullish: rec.bullish.slice(0, 8),
      bearish: rec.bearish.slice(0, 8),
      warnings: rec.warnings,
      marketRegime: rec.regime.label,
      plannedRewardRisk: plan.rewardRisk,
      snapshot: captureThesis(rec, rec.regime.label),
    },
    fills: [fill],
    highWater: entry,
    lastPrice: entry,
    lastCheckedAt: now,
    status: "open",
    realizedR: 0,
    realizedPct: 0,
  };

  return {
    position,
    event: {
      kind: "opened",
      at: now,
      positionId: position.id,
      symbol: position.symbol,
      price: entry,
      detail: `${rec.grade} · ${rec.horizon} · ${plan.rewardRisk}R planned`,
      reason: "entry",
    },
  };
}

// ── Management ───────────────────────────────────────────────────────────

/**
 * Advance one position by one bar.
 *
 * Ordering within the bar is deliberately pessimistic: if the bar's range
 * covers both the stop and a target, the stop is taken first. Intrabar
 * sequence is unknowable from OHLC alone, and resolving that ambiguity in our
 * own favour is precisely how a backtest produces a track record that cannot
 * be reproduced with real money.
 */
export async function stepPosition(
  position: Position,
  quote: Quote,
  config: BotConfig = DEFAULT_BOT_CONFIG,
  broker: Broker = new PaperBroker(),
): Promise<{ position: Position; events: PositionEvent[] }> {
  if (position.status === "closed") return { position, events: [] };

  const events: PositionEvent[] = [];
  const { bar } = quote;
  let next: Position = {
    ...position,
    lastPrice: bar.c,
    lastCheckedAt: bar.t,
    highWater: Math.max(position.highWater, bar.h),
  };

  const push = (
    kind: PositionEvent["kind"],
    price: number,
    detail: string,
    reason?: PositionEvent["reason"],
    rMultiple?: number,
  ) => {
    events.push({
      kind, at: bar.t, positionId: next.id, symbol: next.symbol, price, detail, reason, rMultiple,
    });
  };

  // ── 1. Stop first, always ──
  if (bar.l <= next.stop) {
    const reason =
      next.stop > next.initialStop
        ? next.stop >= next.entry
          ? next.targetsHit >= config.trailAfterTargets
            ? ("trailing" as const)
            : ("breakeven" as const)
          : ("stop" as const)
        : ("stop" as const);

    const fill = await broker.sell(next, next.stop, next.remaining, reason, bar.t);
    next = recompute({
      ...next,
      fills: [...next.fills, fill],
      remaining: 0,
      status: "closed",
      closedAt: bar.t,
      exitReason: reason,
    });
    push("closed", fill.price, `stopped out (${reason})`, reason, fill.rMultiple);
    return { position: next, events };
  }

  // ── 1b. Has the reason for the trade disappeared? ──
  // Checked before targets so a broken thesis exits now rather than waiting to
  // be filled at a level the market is no longer heading toward.
  if (config.thesisExitEnabled && quote.analysis && next.thesis.snapshot) {
    const check = checkThesis(
      next.thesis.snapshot,
      quote.analysis,
      quote.marketLabel ?? next.thesis.snapshot.marketLabel,
    );

    if (check.severity !== "intact") {
      // Named distinctly: `events` is already the PositionEvent list this
      // function returns, and shadowing it silently returned the wrong one.
      const thesisLog = [
        ...(next.thesisEvents ?? []),
        { at: bar.t, severity: check.severity, reasons: check.reasons },
      ];

      if (check.severity === "broken") {
        const fill = await broker.sell(next, bar.c, next.remaining, "thesis", bar.t);
        next = recompute({
          ...next,
          fills: [...next.fills, fill],
          remaining: 0,
          status: "closed",
          closedAt: bar.t,
          exitReason: "thesis",
          thesisEvents: thesisLog,
        });
        push("closed", fill.price, `thesis broken — ${check.reasons.join(", ")}`, "thesis", fill.rMultiple);
        return { position: next, events };
      }

      // Weakening: take half off and let the rest prove itself. Only once —
      // a position cannot be scaled out of repeatedly for the same reason.
      const alreadyScaled = (next.thesisEvents ?? []).some((e) => e.severity === "weakening");
      if (!alreadyScaled) {
        const fraction = Math.min(check.releaseFraction, next.remaining);
        if (fraction > 0) {
          const fill = await broker.sell(next, bar.c, fraction, "weakened", bar.t);
          const remaining = Number((next.remaining - fraction).toFixed(6));
          next = recompute({
            ...next,
            fills: [...next.fills, fill],
            remaining,
            thesisEvents: thesisLog,
          });
          push("partial", fill.price, `thesis weakening — ${check.reasons.join(", ")}`, "weakened", fill.rMultiple);
          if (remaining <= 0) {
            next = { ...next, status: "closed", closedAt: bar.t, exitReason: "weakened" };
            return { position: next, events };
          }
        }
      } else {
        next = { ...next, thesisEvents: thesisLog };
      }
    }
  }

  // ── 2. Targets, in order ──
  while (next.targetsHit < next.targets.length) {
    const target = next.targets[next.targetsHit];
    if (bar.h < target.price) break;

    // Runner mode: in a confirmed trend the final tranche is released from its
    // cap and trailed instead. Closing every winner at a fixed third target
    // guarantees the bot never captures a large rise — and large rises are
    // where a trend strategy's entire profit comes from.
    const isFinalTarget = next.targetsHit === next.targets.length - 1;
    if (
      isFinalTarget &&
      config.runnerEnabled &&
      quote.analysis &&
      shouldRun(quote.analysis)
    ) {
      next = { ...next, targetsHit: next.targetsHit + 1, running: true };
      push("stop-moved", target.price, "final target released — trailing the trend");
      break;
    }

    const fraction = Math.min(target.allocationPct / 100, next.remaining);
    if (fraction <= 0) break;

    const fill = await broker.sell(next, target.price, fraction, "target", bar.t);
    const remaining = Number((next.remaining - fraction).toFixed(6));
    next = recompute({
      ...next,
      fills: [...next.fills, fill],
      remaining,
      targetsHit: next.targetsHit + 1,
    });
    push(
      remaining <= 0 ? "closed" : "partial",
      fill.price,
      `target ${next.targetsHit} filled — ${target.allocationPct}% released`,
      "target",
      fill.rMultiple,
    );

    if (remaining <= 0) {
      next = { ...next, status: "closed", closedAt: bar.t, exitReason: "target" };
      return { position: next, events };
    }
  }

  // ── 3. Protect the position once it has paid for itself ──
  if (next.targetsHit >= config.breakevenAfterTargets && next.stop < next.entry) {
    next = { ...next, stop: next.entry };
    push("stop-moved", next.entry, "stop moved to breakeven");
  }

  // ── 4. Trail behind the high-water mark ──
  // The multiple adapts: a confirmed trend earns more room so the move can
  // actually be captured, while chop is trailed tightly because there is no
  // move to capture and the only question is how much profit survives.
  if ((next.targetsHit >= config.trailAfterTargets || next.running) && quote.atr > 0) {
    const multiple = quote.analysis
      ? trailMultiple(quote.analysis, config.trailAtrMultiple)
      : config.trailAtrMultiple;
    const trailed = next.highWater - quote.atr * multiple;
    // A stop may only ever move in our favour. Widening a stop to "give the
    // trade room" is the single most reliable way to turn a small loss into
    // an account-ending one, so it is not expressible here.
    if (trailed > next.stop) {
      next = { ...next, stop: trailed };
      push("stop-moved", trailed, "trailing stop raised");
    }
  }

  // ── 5. Cut a thesis that has gone stale ──
  const ageHours = (bar.t - next.openedAt) / 3_600_000;
  const currentR = rMultipleOf(next.entry, next.initialStop, bar.c);
  // A running position is working by definition; age is not a reason to cut it.
  if (!next.running && ageHours >= config.maxHoldHours && currentR < config.staleBelowR) {
    const fill = await broker.sell(next, bar.c, next.remaining, "time", bar.t);
    next = recompute({
      ...next,
      fills: [...next.fills, fill],
      remaining: 0,
      status: "closed",
      closedAt: bar.t,
      exitReason: "time",
    });
    push("closed", fill.price, `held ${Math.round(ageHours)}h without progress`, "time", fill.rMultiple);
    return { position: next, events };
  }

  return { position: next, events };
}

/** Force-close a position — used when the regime turns hostile. */
export async function closePosition(
  position: Position,
  price: number,
  reason: Position["exitReason"] = "manual",
  broker: Broker = new PaperBroker(),
  at = Date.now(),
): Promise<{ position: Position; event: PositionEvent }> {
  const fill = await broker.sell(position, price, position.remaining, reason ?? "manual", at);
  const next = recompute({
    ...position,
    fills: [...position.fills, fill],
    remaining: 0,
    status: "closed",
    closedAt: at,
    exitReason: reason,
  });
  return {
    position: next,
    event: {
      kind: "closed",
      at,
      positionId: next.id,
      symbol: next.symbol,
      price: fill.price,
      detail: `closed (${reason})`,
      reason: reason ?? "manual",
      rMultiple: fill.rMultiple,
    },
  };
}

/** Advance every open position, then move the finished ones into history. */
export async function manage(
  state: BotState,
  quotes: Quote[],
  config: BotConfig = DEFAULT_BOT_CONFIG,
  broker: Broker = new PaperBroker(),
): Promise<BotState> {
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const stillOpen: Position[] = [];
  const newlyClosed: Position[] = [];
  const events: PositionEvent[] = [];

  for (const position of state.positions) {
    const quote = bySymbol.get(position.symbol);
    if (!quote) {
      // No fresh bar for this symbol — leave it untouched rather than guessing.
      stillOpen.push(position);
      continue;
    }
    const result = await stepPosition(position, quote, config, broker);
    events.push(...result.events);
    if (result.position.status === "closed") newlyClosed.push(result.position);
    else stillOpen.push(result.position);
  }

  const closed = [...state.closed, ...newlyClosed];
  let cumulative = state.equityR.length
    ? state.equityR[state.equityR.length - 1].cumulative
    : 0;
  const equityR = [...state.equityR];
  for (const position of newlyClosed) {
    cumulative = Number((cumulative + position.realizedR).toFixed(4));
    equityR.push({ at: position.closedAt ?? Date.now(), cumulative });
  }

  return {
    ...state,
    positions: stillOpen,
    closed,
    events: [...state.events, ...events].slice(-500),
    equityR,
    lastTickAt: Date.now(),
  };
}

/** Consider new entries, respecting every portfolio guard. */
export async function considerEntries(
  state: BotState,
  candidates: Recommendation[],
  config: BotConfig = DEFAULT_BOT_CONFIG,
  broker: Broker = new PaperBroker(),
  now = Date.now(),
): Promise<{ state: BotState; opened: Position[]; refused: { symbol: string; reason: string }[] }> {
  let working = state;
  const opened: Position[] = [];
  const refused: { symbol: string; reason: string }[] = [];

  for (const rec of candidates) {
    const gate = canOpen(working, rec, config);
    if (!gate.ok) {
      refused.push({ symbol: rec.symbol, reason: gate.reason });
      continue;
    }
    const result = await openPosition(rec, config, broker, now);
    if (!result) {
      refused.push({ symbol: rec.symbol, reason: "plan.missing" });
      continue;
    }
    opened.push(result.position);
    working = {
      ...working,
      positions: [...working.positions, result.position],
      events: [...working.events, result.event].slice(-500),
    };
  }

  return { state: working, opened, refused };
}
