/**
 * Domain shapes for the paid providers.
 *
 * These interfaces exist NOW, fully typed, so Stage 6 (on-chain) and Stage 7
 * (aggregated derivatives) of the analysis pipeline are written against a real
 * contract rather than a placeholder. With no key the provider returns
 * `not_configured`, the stage records "غير متاحة", and the confidence score
 * takes a declared penalty that the site displays. Adding a key turns the
 * stage on without touching the pipeline.
 */
import type { Availability } from "@/shared/availability";

/** Stage 6 — on-chain. Exchange flows, holder behaviour, cycle position. */
export interface OnChainMetrics {
  /** Coins moving INTO exchanges: supply arriving to be sold. Negative = outflow. */
  readonly exchangeNetflow: number;
  readonly exchangeNetflowUsd: number;
  /** Total held on exchanges — falling reserves are structurally bullish. */
  readonly exchangeReserve: number;
  /** Net position change of large wallets over the window. */
  readonly whaleNetPosition: number | null;
  /** Ratio of realized profit to realized loss; >1 = holders selling into gains. */
  readonly profitLossRatio: number | null;
  /** MVRV or an equivalent cycle-position proxy, when the provider exposes one. */
  readonly cyclePosition: number | null;
  /** Net stablecoin flow onto exchanges — dry powder arriving. */
  readonly stablecoinNetflowUsd: number | null;
  readonly windowHours: number;
  readonly timestamp: number;
}

export interface OnChainProvider {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  metrics(asset: string, windowHours?: number): Promise<Availability<OnChainMetrics>>;
}

/** Stage 7 — derivatives aggregated across ALL venues, not just ours. */
export interface AggregatedDerivatives {
  readonly openInterestUsd: number;
  readonly openInterestChange24hPct: number | null;
  /** Volume-weighted funding across venues. */
  readonly weightedFundingRate: number;
  /** Where that funding sits inside its own trailing range, 0..1. */
  readonly fundingPercentile: number | null;
  readonly longShortRatio: number | null;
  readonly liquidations24hLongUsd: number | null;
  readonly liquidations24hShortUsd: number | null;
  /** Price levels where leveraged positions cluster — magnets for a sweep. */
  readonly liquidationClusters: readonly { price: number; leveragedUsd: number }[];
  readonly timestamp: number;
}

export interface DerivativesProvider {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  aggregated(symbol: string): Promise<Availability<AggregatedDerivatives>>;
}

/** Stage 7 — social sentiment. Used as a contrarian/confirmation overlay only. */
export interface SocialSentiment {
  /** Composite 0..100 score, provider-defined. */
  readonly score: number | null;
  /** Mentions in the window. */
  readonly socialVolume: number | null;
  /** Change in mentions vs the trailing average — spikes precede reversals. */
  readonly socialVolumeChangePct: number | null;
  /** -1..1 bullish/bearish balance. */
  readonly sentiment: number | null;
  readonly timestamp: number;
}

export interface SocialProvider {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  sentiment(asset: string): Promise<Availability<SocialSentiment>>;
}
