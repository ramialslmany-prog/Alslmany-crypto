/**
 * Coinglass — derivatives aggregated across every venue. DISABLED until
 * COINGLASS_API_KEY is set.
 *
 * Why it matters even though we already read Binance futures directly: funding
 * and open interest on ONE venue can diverge sharply from the market as a
 * whole. Single-venue funding that looks extreme is often just that venue's
 * book. Without this key the derivatives stage says so and narrows its claim.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { getJson, qs } from "@/data/http";
import type { AggregatedDerivatives, DerivativesProvider } from "@/data/premium/types";
import type { AppConfig } from "@/shared/config";

interface CgEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

export class CoinglassProvider implements DerivativesProvider {
  readonly id = "coinglass";
  readonly label = "Coinglass — مشتقّات مجمّعة";

  constructor(private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.cfg.COINGLASS_API_KEY);
  }

  private get<T>(path: string, params: Record<string, string | number>): Promise<Availability<CgEnvelope<T>>> {
    return getJson<CgEnvelope<T>>(
      `${this.cfg.COINGLASS_BASE.replace(/\/$/, "")}${path}${qs(params)}`,
      {
        source: `coinglass:${path}`,
        headers: { "CG-API-KEY": this.cfg.COINGLASS_API_KEY ?? "" },
        timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
        retries: this.cfg.HTTP_RETRIES,
        userAgent: this.cfg.HTTP_USER_AGENT,
      },
    );
  }

  async aggregated(symbol: string): Promise<Availability<AggregatedDerivatives>> {
    if (!this.enabled) {
      return unavailable(
        "coinglass",
        "not_configured",
        "ضع COINGLASS_API_KEY لقراءة المشتقّات عبر كل المنصّات",
      );
    }
    const coin = symbol.replace(/USDT$|USD$/i, "").toUpperCase();

    const [oi, funding, liq] = await Promise.all([
      this.get<OiRow[]>("/futures/open-interest/exchange-list", { symbol: coin }),
      this.get<FundingRow[]>("/futures/funding-rate/exchange-list", { symbol: coin }),
      this.get<LiqRow>("/futures/liquidation/coin-list", { symbol: coin }),
    ]);

    if (!oi.available) return oi;
    const oiRows = oi.value.data ?? [];
    const all = oiRows.find((r) => (r.exchange ?? "").toLowerCase() === "all") ?? oiRows[0];
    if (!all) return unavailable("coinglass", "bad_response", "لا بيانات عقود مفتوحة");

    // Volume-weight funding across venues; a simple mean would let a tiny
    // venue with a wild rate dominate the reading.
    let weightedFunding = NaN;
    let fundingPercentile: number | null = null;
    if (funding.available) {
      const rows = (funding.value.data ?? []).filter(
        (f) => Number.isFinite(Number(f.fundingRate)) && Number(f.openInterest) > 0,
      );
      const totalOi = rows.reduce((s, f) => s + Number(f.openInterest), 0);
      if (totalOi > 0) {
        weightedFunding =
          rows.reduce((s, f) => s + Number(f.fundingRate) * Number(f.openInterest), 0) / totalOi;
      }
    }

    const liqRow = liq.available ? liq.value.data : undefined;

    return available(
      {
        openInterestUsd: Number(all.openInterest ?? NaN),
        openInterestChange24hPct: Number.isFinite(Number(all.change24h)) ? Number(all.change24h) : null,
        weightedFundingRate: weightedFunding,
        fundingPercentile,
        longShortRatio: null,
        liquidations24hLongUsd: liqRow ? Number(liqRow.longLiquidationUsd24h ?? NaN) : null,
        liquidations24hShortUsd: liqRow ? Number(liqRow.shortLiquidationUsd24h ?? NaN) : null,
        liquidationClusters: [],
        timestamp: Date.now(),
      },
      "coinglass",
      oi.asOf,
    );
  }
}

interface OiRow {
  exchange?: string;
  openInterest?: number | string;
  change24h?: number | string;
}

interface FundingRow {
  exchange?: string;
  fundingRate?: number | string;
  openInterest?: number | string;
}

interface LiqRow {
  longLiquidationUsd24h?: number | string;
  shortLiquidationUsd24h?: number | string;
}
