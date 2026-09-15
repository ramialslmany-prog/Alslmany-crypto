/**
 * Portfolio protection.
 *
 * These are HARD LIMITS, not suggestions, and they are the part of the system
 * most likely to be the reason the account still exists in a year. Every one
 * is checked before a position opens, and the two circuit breakers are also
 * checked continuously.
 *
 * The distinction that matters: the daily-loss breaker RESUMES ITSELF after
 * its cooldown, because a bad day is normal. The drawdown breaker DOES NOT —
 * it requires a human to clear it, because a 15% fall from peak means the
 * strategy may simply be wrong for the current market, and a bot that
 * restarts itself after that is a bot that will find out how much worse it
 * can get.
 */
import type { CircuitBreaker, PortfolioSnapshot, Position } from "@/core/execution/types";
import type { Direction } from "@/core/types";

export interface RiskLimits {
  readonly riskPerTradePct: number;
  readonly maxOpenPositions: number;
  readonly maxCorrelatedPositions: number;
  readonly correlationThreshold: number;
  readonly dailyLossHaltPct: number;
  readonly dailyHaltHours: number;
  readonly maxDrawdownHaltPct: number;
}

export interface RiskCheckInput {
  readonly snapshot: PortfolioSnapshot;
  readonly openPositions: readonly Position[];
  readonly candidate: { symbol: string; direction: Direction };
  /** Pairwise correlations with the open positions, by symbol. */
  readonly correlations: Record<string, number>;
  readonly activeBreakers: readonly CircuitBreaker[];
  readonly limits: RiskLimits;
  readonly now: number;
}

export interface RiskBlocker {
  readonly id: string;
  readonly arabic: string;
  readonly actual: string;
  readonly limit: string;
}

export interface RiskDecision {
  readonly allowed: boolean;
  readonly blockers: readonly RiskBlocker[];
  readonly correlatedCount: number;
  readonly arabic: string;
}

export function checkRisk(input: RiskCheckInput): RiskDecision {
  const blockers: RiskBlocker[] = [];
  const { limits, snapshot } = input;

  // ── circuit breakers ─────────────────────────────────────────────────────
  for (const breaker of activeBreakers(input.activeBreakers, input.now)) {
    blockers.push({
      id: `circuit_${breaker.kind}`,
      arabic: breaker.arabic,
      actual: "مفعّل",
      limit: "معطّل",
    });
  }

  // ── position count ───────────────────────────────────────────────────────
  if (input.openPositions.length >= limits.maxOpenPositions) {
    blockers.push({
      id: "max_positions",
      arabic: `عدد المراكز المفتوحة ${input.openPositions.length} بلغ الحد الأقصى ${limits.maxOpenPositions}`,
      actual: String(input.openPositions.length),
      limit: String(limits.maxOpenPositions),
    });
  }

  // ── correlated exposure ──────────────────────────────────────────────────
  // Three positions correlated at 0.9 in the same direction are not three
  // independent bets risking 1% each. They are one bet risking 3%, and the
  // portfolio only finds that out on the day they all lose together.
  const correlated = input.openPositions.filter((p) => {
    if (p.direction !== input.candidate.direction) return false;
    const correlation = input.correlations[p.symbol];
    return correlation !== undefined && Math.abs(correlation) >= limits.correlationThreshold;
  });

  if (correlated.length >= limits.maxCorrelatedPositions) {
    blockers.push({
      id: "correlated_exposure",
      arabic:
        `${correlated.length} مراكز مترابطة فوق ${limits.correlationThreshold} في نفس الاتجاه ` +
        `(${correlated.map((p) => p.symbol).join("، ")}). ` +
        "هذه ليست مراكز مستقلة تخاطر بـ1% لكل منها، بل مركز واحد يخاطر بمجموعها.",
      actual: String(correlated.length),
      limit: String(limits.maxCorrelatedPositions),
    });
  }

  const allowed = blockers.length === 0;
  return {
    allowed,
    blockers,
    correlatedCount: correlated.length,
    arabic: allowed
      ? `فحص المخاطر مرّ: ${input.openPositions.length} من ${limits.maxOpenPositions} مراكز، ` +
        `${correlated.length} مترابط من ${limits.maxCorrelatedPositions} مسموح، ` +
        `التراجع الحالي ${snapshot.drawdownPct.toFixed(2)}%.`
      : `فحص المخاطر منع الصفقة: ${blockers.map((b) => b.arabic).join(" · ")}`,
  };
}

/** Breakers still in force at `now`. */
export function activeBreakers(
  breakers: readonly CircuitBreaker[],
  now: number,
): CircuitBreaker[] {
  return breakers.filter((b) => {
    if (b.requiresManualReset) return true;
    return b.resumesAt === null || now < b.resumesAt;
  });
}

/**
 * Should a breaker trip right now?
 *
 * Called after every equity update, not only after a loss — the drawdown
 * breaker must fire the moment the threshold is crossed, however it got there.
 */
export function evaluateBreakers(
  snapshot: PortfolioSnapshot,
  limits: RiskLimits,
  existing: readonly CircuitBreaker[],
  now: number,
): CircuitBreaker[] {
  const tripped: CircuitBreaker[] = [];
  const alreadyActive = new Set(activeBreakers(existing, now).map((b) => b.kind));

  // ── daily loss: pauses, then resumes itself ──────────────────────────────
  if (!alreadyActive.has("daily_loss") && snapshot.dayPnlPct <= -limits.dailyLossHaltPct) {
    tripped.push({
      kind: "daily_loss",
      trippedAt: now,
      resumesAt: now + limits.dailyHaltHours * 3_600_000,
      requiresManualReset: false,
      reason: `daily loss ${snapshot.dayPnlPct.toFixed(2)}% <= -${limits.dailyLossHaltPct}%`,
      arabic:
        `خسارة اليوم بلغت ${snapshot.dayPnlPct.toFixed(2)}% وتجاوزت حد ${limits.dailyLossHaltPct}%. ` +
        `توقّف البوت ${limits.dailyHaltHours} ساعة. ` +
        "يوم سيئ أمر طبيعي، لذلك يستأنف تلقائياً — لكن مواصلة التداول بعد ثلاث خسائر متتالية " +
        "هي كيف يتحوّل اليوم السيئ إلى أسبوع كارثي.",
    });
  }

  // ── max drawdown: stops entirely, needs a human ──────────────────────────
  if (!alreadyActive.has("max_drawdown") && snapshot.drawdownPct >= limits.maxDrawdownHaltPct) {
    tripped.push({
      kind: "max_drawdown",
      trippedAt: now,
      resumesAt: null,
      requiresManualReset: true,
      reason: `drawdown ${snapshot.drawdownPct.toFixed(2)}% >= ${limits.maxDrawdownHaltPct}%`,
      arabic:
        `التراجع من الذروة بلغ ${snapshot.drawdownPct.toFixed(2)}% وتجاوز حد ${limits.maxDrawdownHaltPct}%. ` +
        "توقّف البوت كلياً ولا يستأنف إلا بتشغيل يدوي. " +
        "تراجع بهذا الحجم يعني احتمال أن الاستراتيجية نفسها لا تناسب السوق الحالي، " +
        "وبوت يستأنف تلقائياً بعده هو بوت سيكتشف كم يمكن أن يسوء الأمر.",
    });
  }

  return tripped;
}

/**
 * Recompute the portfolio snapshot.
 *
 * `peakEquity` only ever rises — that is what makes drawdown mean "from the
 * high-water mark" rather than "from wherever we happened to start".
 */
export function updateSnapshot(
  previous: PortfolioSnapshot,
  equity: number,
  openPositions: readonly Position[],
  now: number,
  dayStartEquity?: number,
): PortfolioSnapshot {
  const peakEquity = Math.max(previous.peakEquity, equity);
  const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
  const dayStart = dayStartEquity ?? previous.dayStartEquity;
  const dayPnlPct = dayStart > 0 ? ((equity - dayStart) / dayStart) * 100 : 0;
  const exposureNotional = openPositions.reduce(
    (s, p) => s + p.openQuantity * (p.averageEntry || p.plannedEntry.mid),
    0,
  );

  return {
    at: now,
    equity,
    cash: equity - exposureNotional,
    openPositions: openPositions.length,
    exposureNotional,
    peakEquity,
    drawdownPct,
    dayStartEquity: dayStart,
    dayPnlPct,
  };
}

/**
 * Units to buy for a fixed fractional risk.
 *
 * The only correct sizing rule: the account risks a constant fraction, and
 * how many units that buys falls out of how far away the invalidation is.
 * Sizing by a fixed notional instead means every wide-stop trade risks more
 * than every tight-stop one, silently.
 */
export function positionSizeFor(
  equity: number,
  riskPercent: number,
  entryPrice: number,
  stopPrice: number,
): { size: number; riskAmount: number; riskPerUnit: number } | null {
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (!(riskPerUnit > 0) || !(equity > 0)) return null;
  const riskAmount = equity * (riskPercent / 100);
  return { size: riskAmount / riskPerUnit, riskAmount, riskPerUnit };
}
