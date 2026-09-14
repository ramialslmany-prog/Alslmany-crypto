/**
 * CoinGecko — market-wide aggregates and token fundamentals. Free tier, no key
 * required (a demo key simply raises the rate limit).
 *
 * The free tier is roughly 10–30 calls/minute and bans aggressively, so the
 * bucket here is deliberately tight and the coin-id map is cached for a day:
 * the ticker→id mapping changes about as often as a new listing appears.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { configureRateLimit, getJson, qs } from "@/data/http";
import type { GlobalMarket } from "@/core/types";
import type { GlobalMarketSource } from "@/data/market-source";
import type { AppConfig } from "@/shared/config";

interface CgGlobal {
  data?: {
    total_market_cap?: Record<string, number>;
    total_volume?: Record<string, number>;
    market_cap_percentage?: Record<string, number>;
    updated_at?: number;
  };
}

interface CgCoinListRow {
  id: string;
  symbol: string;
  name: string;
}

export interface CoinFundamentals {
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  readonly marketCap: number | null;
  readonly marketCapRank: number | null;
  readonly circulatingSupply: number | null;
  readonly totalSupply: number | null;
  readonly maxSupply: number | null;
  readonly fullyDilutedValuation: number | null;
  readonly athChangePct: number | null;
  readonly genesisDate: string | null;
}

export class CoinGeckoSource implements GlobalMarketSource {
  readonly id = "coingecko";
  private idMap: { at: number; bySymbol: Map<string, string> } | null = null;
  private static readonly ID_MAP_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(private readonly cfg: AppConfig) {
    // Free tier is ~10-30/min. 30 burst, 0.2/s ≈ 12/min sustained.
    configureRateLimit(hostOf(cfg.COINGECKO_BASE), 30, 0.2);
  }

  private base(): string {
    return this.cfg.COINGECKO_BASE.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return this.cfg.COINGECKO_API_KEY
      ? { "x-cg-demo-api-key": this.cfg.COINGECKO_API_KEY }
      : {};
  }

  private get<T>(path: string, source: string): Promise<Availability<T>> {
    return getJson<T>(`${this.base()}${path}`, {
      source,
      headers: this.headers(),
      timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    });
  }

  /** BTC dominance and its trend drive the Stage 2 macro gate. */
  async global(): Promise<Availability<GlobalMarket>> {
    const r = await this.get<CgGlobal>("/global", "coingecko:global");
    if (!r.available) return r;
    const d = r.value.data;
    if (!d?.total_market_cap?.usd) {
      return unavailable("coingecko:global", "bad_response", "لا يوجد total_market_cap");
    }
    return available(
      {
        totalMarketCap: d.total_market_cap.usd,
        totalVolume24h: d.total_volume?.usd ?? NaN,
        btcDominance: d.market_cap_percentage?.btc ?? NaN,
        ethDominance: d.market_cap_percentage?.eth ?? NaN,
        timestamp: (d.updated_at ?? 0) * 1000 || r.asOf,
      },
      r.source,
      (d.updated_at ?? 0) * 1000 || r.asOf,
    );
  }

  /**
   * Ticker → CoinGecko id. Several coins share a ticker (three "SOL"s exist),
   * so we resolve against a market-cap-ranked list and keep the top one. The
   * chosen id is returned to callers so the site can show which asset it read.
   */
  private async symbolIndex(): Promise<Availability<Map<string, string>>> {
    const now = Date.now();
    if (this.idMap && now - this.idMap.at < CoinGeckoSource.ID_MAP_TTL_MS) {
      return available(this.idMap.bySymbol, "coingecko:coinsList", this.idMap.at);
    }
    // Ranked list first — it disambiguates duplicate tickers by market cap.
    const ranked = await this.get<{ id: string; symbol: string }[]>(
      `/coins/markets${qs({
        vs_currency: "usd",
        order: "market_cap_desc",
        per_page: 250,
        page: 1,
        sparkline: false,
      })}`,
      "coingecko:markets",
    );
    const bySymbol = new Map<string, string>();
    if (ranked.available) {
      for (const row of ranked.value) {
        const s = row.symbol.toUpperCase();
        if (!bySymbol.has(s)) bySymbol.set(s, row.id);
      }
    }
    // Fill the long tail from the full list (first-seen wins, ranked entries stay).
    const all = await this.get<CgCoinListRow[]>("/coins/list", "coingecko:coinsList");
    if (all.available) {
      for (const row of all.value) {
        const s = row.symbol.toUpperCase();
        if (!bySymbol.has(s)) bySymbol.set(s, row.id);
      }
    } else if (!ranked.available) {
      return all;
    }
    this.idMap = { at: now, bySymbol };
    return available(bySymbol, "coingecko:coinsList", now);
  }

  async fundamentals(ticker: string): Promise<Availability<CoinFundamentals>> {
    const idx = await this.symbolIndex();
    if (!idx.available) return idx;
    const id = idx.value.get(ticker.toUpperCase());
    if (!id) {
      return unavailable("coingecko:markets", "unsupported_symbol", ticker);
    }
    const r = await this.get<CgMarketRow[]>(
      `/coins/markets${qs({ vs_currency: "usd", ids: id, sparkline: false })}`,
      "coingecko:markets",
    );
    if (!r.available) return r;
    const row = r.value?.[0];
    if (!row) return unavailable("coingecko:markets", "unsupported_symbol", ticker);
    return available(
      {
        id: row.id,
        symbol: row.symbol.toUpperCase(),
        name: row.name,
        marketCap: row.market_cap ?? null,
        marketCapRank: row.market_cap_rank ?? null,
        circulatingSupply: row.circulating_supply ?? null,
        totalSupply: row.total_supply ?? null,
        maxSupply: row.max_supply ?? null,
        fullyDilutedValuation: row.fully_diluted_valuation ?? null,
        athChangePct: row.ath_change_percentage ?? null,
        genesisDate: null,
      },
      r.source,
      row.last_updated ? Date.parse(row.last_updated) : r.asOf,
    );
  }
}

interface CgMarketRow {
  id: string;
  symbol: string;
  name: string;
  market_cap?: number;
  market_cap_rank?: number;
  circulating_supply?: number;
  total_supply?: number;
  max_supply?: number;
  fully_diluted_valuation?: number;
  ath_change_percentage?: number;
  last_updated?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
