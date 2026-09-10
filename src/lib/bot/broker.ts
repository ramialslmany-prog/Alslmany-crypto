import type { Fill, FillReason, Position } from "./types";

/**
 * The execution port.
 *
 * The strategy talks to this interface and never learns whether its fills are
 * simulated or real. Only a paper implementation ships: this product holds no
 * exchange keys and moves no money. Keeping the seam here means a real adapter
 * could be added later without the strategy changing at all, which is the only
 * safe way to approach that boundary.
 */
export interface Broker {
  readonly kind: "paper" | "live";
  /** Open a position at the given price. */
  buy(symbol: string, price: number, sizePct: number, at: number): Promise<Fill>;
  /** Release `fraction` (0–1) of the original position. */
  sell(
    position: Position,
    price: number,
    fraction: number,
    reason: FillReason,
    at: number,
  ): Promise<Fill>;
}

/** Reward in R for a move from entry to `price`, anchored to the initial stop. */
export function rMultipleOf(entry: number, initialStop: number, price: number): number {
  const risk = entry - initialStop;
  if (!(risk > 0)) return 0;
  return Number(((price - entry) / risk).toFixed(4));
}

/**
 * Paper execution.
 *
 * Fills are modelled with slippage against us in both directions — buys fill a
 * touch high, sells a touch low. A simulator that fills perfectly flatters
 * every strategy run through it, and a track record built on perfect fills is
 * not a track record.
 */
export class PaperBroker implements Broker {
  readonly kind = "paper" as const;

  constructor(private readonly slippageBps = 5) {}

  private slip(price: number, direction: "buy" | "sell") {
    const factor = this.slippageBps / 10_000;
    return direction === "buy" ? price * (1 + factor) : price * (1 - factor);
  }

  async buy(_symbol: string, price: number, _sizePct: number, at: number): Promise<Fill> {
    return { at, price: this.slip(price, "buy"), fraction: 1, reason: "entry", rMultiple: 0 };
  }

  async sell(
    position: Position,
    price: number,
    fraction: number,
    reason: FillReason,
    at: number,
  ): Promise<Fill> {
    const filled = this.slip(price, "sell");
    return {
      at,
      price: filled,
      fraction: Number(Math.min(Math.max(fraction, 0), 1).toFixed(6)),
      reason,
      rMultiple: rMultipleOf(position.entry, position.initialStop, filled),
    };
  }
}
