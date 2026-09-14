/**
 * CryptoQuant — on-chain. DISABLED until CRYPTOQUANT_API_KEY is set.
 *
 * The request shapes below are real, so enabling this is a config change. What
 * this class will NEVER do is return a plausible-looking number when it has no
 * key: it returns `not_configured`, Stage 6 records "غير متاحة", and the site
 * shows the confidence penalty that absence caused.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { getJson, qs } from "@/data/http";
import type { OnChainMetrics, OnChainProvider } from "@/data/premium/types";
import type { AppConfig } from "@/shared/config";

interface CqSeries {
  result?: { data?: Record<string, string | number>[] };
}

export class CryptoQuantProvider implements OnChainProvider {
  readonly id = "cryptoquant";
  readonly label = "CryptoQuant — بيانات السلسلة";

  constructor(private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.cfg.CRYPTOQUANT_API_KEY);
  }

  private async series(path: string, params: Record<string, string | number>): Promise<Availability<Record<string, string | number>[]>> {
    const r = await getJson<CqSeries>(
      `${this.cfg.CRYPTOQUANT_BASE.replace(/\/$/, "")}${path}${qs(params)}`,
      {
        source: `cryptoquant:${path}`,
        headers: { authorization: `Bearer ${this.cfg.CRYPTOQUANT_API_KEY}` },
        timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
        retries: this.cfg.HTTP_RETRIES,
        userAgent: this.cfg.HTTP_USER_AGENT,
      },
    );
    if (!r.available) return r;
    const rows = r.value.result?.data ?? [];
    if (rows.length === 0) return unavailable(r.source, "bad_response", "سلسلة فارغة");
    return available(rows, r.source, r.asOf);
  }

  async metrics(asset: string, windowHours = 24): Promise<Availability<OnChainMetrics>> {
    if (!this.enabled) {
      return unavailable(
        "cryptoquant",
        "not_configured",
        "ضع CRYPTOQUANT_API_KEY لتفعيل بيانات السلسلة",
      );
    }
    const token = asset.toLowerCase();
    const window = windowHours >= 24 ? "day" : "hour";
    const common = { exchange: "all_exchange", window, limit: 2 };

    const [flow, reserve] = await Promise.all([
      this.series(`/${token}/exchange-flows/netflow`, common),
      this.series(`/${token}/exchange-flows/reserve`, common),
    ]);
    if (!flow.available) return flow;

    const latestFlow = flow.value[0];
    const latestReserve = reserve.available ? reserve.value[0] : undefined;
    const ts = Number(latestFlow.datetime ?? latestFlow.date ?? Date.now());

    return available(
      {
        exchangeNetflow: Number(latestFlow.netflow_total ?? NaN),
        exchangeNetflowUsd: Number(latestFlow.netflow_total_usd ?? NaN),
        exchangeReserve: Number(latestReserve?.reserve ?? NaN),
        whaleNetPosition: null,
        profitLossRatio: null,
        cyclePosition: null,
        stablecoinNetflowUsd: null,
        windowHours,
        timestamp: Number.isFinite(ts) ? ts : Date.now(),
      },
      "cryptoquant",
      Number.isFinite(ts) ? ts : Date.now(),
    );
  }
}
