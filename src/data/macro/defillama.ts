/**
 * DefiLlama — TVL and protocol revenue. Free, no key.
 *
 * Feeds the fundamental side of the eligibility and context stages: a token
 * whose protocol TVL is collapsing while price holds is a different trade from
 * one where both rise together.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { getJson } from "@/data/http";
import type { ProtocolTvl } from "@/core/types";
import type { AppConfig } from "@/shared/config";

interface LlamaProtocol {
  name: string;
  symbol: string | null;
  tvl: number | null;
  change_1d: number | null;
  change_7d: number | null;
  category?: string;
  chains?: string[];
}

interface LlamaFeeRow {
  name?: string;
  total24h?: number | null;
}

export class DefiLlamaSource {
  readonly id = "defillama";
  private protocolCache: { at: number; rows: LlamaProtocol[] } | null = null;
  private revenueCache: { at: number; byName: Map<string, number> } | null = null;

  /** TVL moves slowly; refetching the full protocol list more than hourly is waste. */
  private static readonly TTL_MS = 60 * 60 * 1000;

  constructor(private readonly cfg: AppConfig) {}

  private base(): string {
    return this.cfg.DEFILLAMA_BASE.replace(/\/$/, "");
  }

  private async protocols(): Promise<Availability<LlamaProtocol[]>> {
    const now = Date.now();
    if (this.protocolCache && now - this.protocolCache.at < DefiLlamaSource.TTL_MS) {
      return available(this.protocolCache.rows, "defillama:protocols", this.protocolCache.at);
    }
    const r = await getJson<LlamaProtocol[]>(`${this.base()}/protocols`, {
      source: "defillama:protocols",
      timeoutMs: Math.max(this.cfg.HTTP_TIMEOUT_MS, 30_000), // the payload is large
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    });
    if (!r.available) return r;
    if (!Array.isArray(r.value)) {
      return unavailable("defillama:protocols", "bad_response", "الرد ليس قائمة");
    }
    this.protocolCache = { at: now, rows: r.value };
    return available(r.value, r.source, now);
  }

  /** 24h revenue per protocol, keyed by lowercase name. */
  private async revenueByName(): Promise<Availability<Map<string, number>>> {
    const now = Date.now();
    if (this.revenueCache && now - this.revenueCache.at < DefiLlamaSource.TTL_MS) {
      return available(this.revenueCache.byName, "defillama:revenue", this.revenueCache.at);
    }
    const r = await getJson<{ protocols?: LlamaFeeRow[] }>(
      `${this.base()}/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue`,
      {
        source: "defillama:revenue",
        timeoutMs: Math.max(this.cfg.HTTP_TIMEOUT_MS, 30_000),
        retries: this.cfg.HTTP_RETRIES,
        userAgent: this.cfg.HTTP_USER_AGENT,
      },
    );
    if (!r.available) return r;
    const byName = new Map<string, number>();
    for (const p of r.value.protocols ?? []) {
      if (p.name && typeof p.total24h === "number") byName.set(p.name.toLowerCase(), p.total24h);
    }
    this.revenueCache = { at: now, byName };
    return available(byName, r.source, now);
  }

  /**
   * TVL + revenue for one ticker. DefiLlama keys by protocol name, and several
   * protocols can share a ticker, so we take the largest by TVL and say so.
   */
  async forSymbol(symbol: string): Promise<Availability<ProtocolTvl>> {
    const r = await this.protocols();
    if (!r.available) return r;

    const want = symbol.toUpperCase();
    const matches = r.value.filter((p) => (p.symbol ?? "").toUpperCase() === want && p.tvl != null);
    if (matches.length === 0) {
      return unavailable("defillama:protocols", "unsupported_symbol", `${want} بلا بروتوكول مطابق`);
    }
    matches.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
    const top = matches[0];

    const rev = await this.revenueByName();
    const revenue24h = rev.available ? (rev.value.get(top.name.toLowerCase()) ?? null) : null;

    return available(
      {
        name: top.name,
        symbol: top.symbol,
        tvl: top.tvl ?? 0,
        change1d: top.change_1d,
        change7d: top.change_7d,
        revenue24h,
      },
      "defillama:protocols",
      r.asOf,
    );
  }

  /** Total DeFi TVL — a market-wide risk-appetite gauge for Stage 2. */
  async totalTvl(): Promise<Availability<number>> {
    const r = await this.protocols();
    if (!r.available) return r;
    const total = r.value.reduce((sum, p) => sum + (p.tvl ?? 0), 0);
    return available(total, "defillama:protocols", r.asOf);
  }
}
