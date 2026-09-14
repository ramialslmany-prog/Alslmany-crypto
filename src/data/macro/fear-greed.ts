/**
 * alternative.me Crypto Fear & Greed index — free, no key.
 *
 * Used CONTRARIAN in Stage 7: extreme fear raises the weight of long signals,
 * extreme greed raises the weight of short signals. The raw series is kept so
 * the site can show where today sits inside its own recent range rather than
 * against a fixed 0–100 scale.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { getJson, qs } from "@/data/http";
import type { FearGreed } from "@/core/types";
import type { AppConfig } from "@/shared/config";

interface FngRow {
  value: string;
  value_classification: string;
  timestamp: string;
}

/** Arabic labels for the venue's English classifications. */
const CLASSIFICATION_AR: Record<string, string> = {
  "Extreme Fear": "خوف شديد",
  Fear: "خوف",
  Neutral: "محايد",
  Greed: "طمع",
  "Extreme Greed": "طمع شديد",
};

export function classificationAr(en: string): string {
  return CLASSIFICATION_AR[en] ?? en;
}

export class FearGreedSource {
  readonly id = "alternative.me";

  constructor(private readonly cfg: AppConfig) {}

  /** `limit` days of history, newest last. */
  async history(limit = 90): Promise<Availability<FearGreed[]>> {
    const url = `${this.cfg.FEARGREED_BASE.replace(/\/$/, "")}/fng/${qs({
      limit,
      format: "json",
    })}`;
    const r = await getJson<{ data?: FngRow[] }>(url, {
      source: "alternative.me:fng",
      timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
      retries: this.cfg.HTTP_RETRIES,
      userAgent: this.cfg.HTTP_USER_AGENT,
    });
    if (!r.available) return r;

    const rows = r.value.data ?? [];
    if (rows.length === 0) {
      return unavailable("alternative.me:fng", "bad_response", "قائمة فارغة");
    }
    const out = rows
      .map((d): FearGreed => ({
        value: Number(d.value),
        classification: d.value_classification,
        // The venue reports seconds, not milliseconds.
        timestamp: Number(d.timestamp) * 1000,
      }))
      .filter((d) => Number.isFinite(d.value) && Number.isFinite(d.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (out.length === 0) {
      return unavailable("alternative.me:fng", "bad_response", "لا قيم صالحة");
    }
    // asOf is the data's own date, not fetch time — freshness must be real.
    return available(out, "alternative.me:fng", out[out.length - 1].timestamp);
  }

  async latest(): Promise<Availability<FearGreed>> {
    const r = await this.history(2);
    if (!r.available) return r;
    const last = r.value[r.value.length - 1];
    return available(last, r.source, last.timestamp);
  }
}
