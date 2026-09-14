/**
 * LunarCrush — social sentiment. DISABLED until LUNARCRUSH_API_KEY is set.
 *
 * Social data is used defensively, never as a reason to enter: a mention spike
 * against a flat price is a crowding warning. Without a key the sentiment
 * stage falls back to Fear & Greed alone and declares the narrower basis.
 */
import type { Availability } from "@/shared/availability";
import { available, unavailable } from "@/shared/availability";
import { getJson } from "@/data/http";
import type { SocialProvider, SocialSentiment } from "@/data/premium/types";
import type { AppConfig } from "@/shared/config";

interface LcResponse {
  data?: {
    galaxy_score?: number;
    social_volume_24h?: number;
    social_dominance?: number;
    sentiment?: number;
    percent_change_24h?: number;
  };
}

export class LunarCrushProvider implements SocialProvider {
  readonly id = "lunarcrush";
  readonly label = "LunarCrush — المشاعر الاجتماعية";

  constructor(private readonly cfg: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.cfg.LUNARCRUSH_API_KEY);
  }

  async sentiment(asset: string): Promise<Availability<SocialSentiment>> {
    if (!this.enabled) {
      return unavailable(
        "lunarcrush",
        "not_configured",
        "ضع LUNARCRUSH_API_KEY لتفعيل المشاعر الاجتماعية",
      );
    }
    const coin = asset.replace(/USDT$|USD$/i, "").toUpperCase();
    const r = await getJson<LcResponse>(
      `${this.cfg.LUNARCRUSH_BASE.replace(/\/$/, "")}/coins/${coin}/v1`,
      {
        source: "lunarcrush",
        headers: { authorization: `Bearer ${this.cfg.LUNARCRUSH_API_KEY}` },
        timeoutMs: this.cfg.HTTP_TIMEOUT_MS,
        retries: this.cfg.HTTP_RETRIES,
        userAgent: this.cfg.HTTP_USER_AGENT,
      },
    );
    if (!r.available) return r;
    const d = r.value.data;
    if (!d) return unavailable("lunarcrush", "bad_response", "لا بيانات");

    return available(
      {
        score: d.galaxy_score ?? null,
        socialVolume: d.social_volume_24h ?? null,
        socialVolumeChangePct: d.percent_change_24h ?? null,
        // LunarCrush reports 0..100; normalize to the -1..1 contract.
        sentiment: typeof d.sentiment === "number" ? d.sentiment / 50 - 1 : null,
        timestamp: r.asOf,
      },
      "lunarcrush",
      r.asOf,
    );
  }
}
