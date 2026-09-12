import "server-only";
import { z } from "zod";
import { fetchJson } from "./http";
import { toPair } from "./exchanges";

/**
 * Derivatives positioning.
 *
 * This is the dimension that most often separates a professional read from an
 * amateur one. Price tells you where the market is; funding, open interest and
 * the long/short ratio tell you *how the crowd is positioned to get there* —
 * and a crowded position is the fuel for the violent move against it.
 *
 * The classic retail death is buying a breakout while funding is extremely
 * positive: everyone is already long with leverage, there is nobody left to
 * buy, and the only liquidity left to take is the stops beneath. Reading this
 * before entering is what turns a coin flip into an informed decision.
 *
 * All endpoints are Binance USD-M Futures public data. No key, no signature.
 */

const FUTURES = "https://fapi.binance.com";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export type FundingRead = {
  /** Latest funding rate as a percentage per interval (usually 8h). */
  ratePct: number;
  /** Annualised, assuming three fundings a day — the number that shows the cost. */
  annualizedPct: number;
  /** Mean of the recent window, so a single spike does not define the read. */
  averagePct: number;
  nextFundingAt: number | null;
};

export type OpenInterestRead = {
  /** Open interest in base units. */
  amount: number;
  /** Notional value in quote currency. */
  notional: number;
  /** Percentage change over the recent window. */
  changePct: number;
};

export type PositioningRead = {
  /** Share of accounts holding longs, 0-100. */
  longAccountPct: number;
  shortAccountPct: number;
  /** Long/short account ratio. */
  ratio: number;
};

export type DerivativesRead = {
  symbol: string;
  funding: FundingRead | null;
  openInterest: OpenInterestRead | null;
  positioning: PositioningRead | null;
  fetchedAt: number;
};

// ── Funding ──────────────────────────────────────────────────────────────

const FundingRow = z.object({
  fundingRate: z.string(),
  fundingTime: z.number(),
});

export async function fetchFunding(symbol: string, limit = 12): Promise<FundingRead> {
  const pair = toPair(symbol);
  const rows = z
    .array(FundingRow)
    .parse(await fetchJson(`${FUTURES}/fapi/v1/fundingRate?symbol=${pair}&limit=${limit}`));
  if (rows.length === 0) throw new Error(`no funding history for ${pair}`);

  const rates = rows.map((r) => num(r.fundingRate)).filter(Number.isFinite);
  const latest = rates[rates.length - 1];
  const average = rates.reduce((s, r) => s + r, 0) / rates.length;

  return {
    ratePct: latest * 100,
    // Funding settles three times a day on Binance.
    annualizedPct: latest * 100 * 3 * 365,
    averagePct: average * 100,
    nextFundingAt: rows[rows.length - 1].fundingTime + 8 * 3_600_000,
  };
}

// ── Open interest ────────────────────────────────────────────────────────

const OiRow = z.object({
  sumOpenInterest: z.string(),
  sumOpenInterestValue: z.string(),
  timestamp: z.number(),
});

export async function fetchOpenInterest(symbol: string, period = "1h"): Promise<OpenInterestRead> {
  const pair = toPair(symbol);
  const rows = z
    .array(OiRow)
    .parse(
      await fetchJson(
        `${FUTURES}/futures/data/openInterestHist?symbol=${pair}&period=${period}&limit=24`,
      ),
    );
  if (rows.length < 2) throw new Error(`insufficient open-interest history for ${pair}`);

  const latest = rows[rows.length - 1];
  const first = rows[0];
  const amount = num(latest.sumOpenInterest);
  const startAmount = num(first.sumOpenInterest);

  return {
    amount,
    notional: num(latest.sumOpenInterestValue),
    changePct: startAmount > 0 ? ((amount - startAmount) / startAmount) * 100 : 0,
  };
}

// ── Account positioning ──────────────────────────────────────────────────

const RatioRow = z.object({
  longAccount: z.string(),
  shortAccount: z.string(),
  longShortRatio: z.string(),
});

export async function fetchPositioning(symbol: string, period = "1h"): Promise<PositioningRead> {
  const pair = toPair(symbol);
  const rows = z
    .array(RatioRow)
    .parse(
      await fetchJson(
        `${FUTURES}/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=${period}&limit=1`,
      ),
    );
  const row = rows[0];
  if (!row) throw new Error(`no positioning data for ${pair}`);

  return {
    longAccountPct: num(row.longAccount) * 100,
    shortAccountPct: num(row.shortAccount) * 100,
    ratio: num(row.longShortRatio),
  };
}

/**
 * Fetch all three together.
 *
 * Each is independently optional: many altcoins have no perpetual listing at
 * all, and a missing derivatives market is a fact about the asset rather than
 * an error. The analysis layer treats null as "unknown" and simply declines to
 * claim anything, instead of substituting a neutral value that would read as
 * evidence of balance.
 */
export async function fetchDerivatives(symbol: string): Promise<DerivativesRead> {
  const [funding, openInterest, positioning] = await Promise.all([
    fetchFunding(symbol).catch(() => null),
    fetchOpenInterest(symbol).catch(() => null),
    fetchPositioning(symbol).catch(() => null),
  ]);

  return { symbol: symbol.toUpperCase(), funding, openInterest, positioning, fetchedAt: Date.now() };
}
