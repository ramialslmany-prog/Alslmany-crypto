/**
 * Per-provider health, persisted so the Health page shows real history rather
 * than whatever happened since the last restart.
 *
 * Section 7 rule 4 of the spec — show the bad as plainly as the good — starts
 * here: a source that failed is recorded with its reason and stays visible.
 */
import type { Db } from "@/storage/db";
import type { Availability, UnavailableReason } from "@/shared/availability";
import { REASON_AR } from "@/shared/availability";

export interface ProviderHealth {
  readonly provider: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly lastOkAt: number | null;
  readonly lastFailAt: number | null;
  readonly lastReason: UnavailableReason | null;
  readonly lastReasonAr: string | null;
  readonly lastDetail: string | null;
  readonly lastLatencyMs: number | null;
  readonly okCount: number;
  readonly failCount: number;
  readonly updatedAt: number;
}

interface Row {
  provider: string;
  label: string;
  enabled: number;
  last_ok_at: number | null;
  last_fail_at: number | null;
  last_reason: string | null;
  last_detail: string | null;
  last_latency_ms: number | null;
  ok_count: number;
  fail_count: number;
  updated_at: number;
}

const toHealth = (r: Row): ProviderHealth => ({
  provider: r.provider,
  label: r.label,
  enabled: r.enabled === 1,
  lastOkAt: r.last_ok_at,
  lastFailAt: r.last_fail_at,
  lastReason: (r.last_reason as UnavailableReason) ?? null,
  lastReasonAr: r.last_reason ? (REASON_AR[r.last_reason as UnavailableReason] ?? r.last_reason) : null,
  lastDetail: r.last_detail,
  lastLatencyMs: r.last_latency_ms,
  okCount: r.ok_count,
  failCount: r.fail_count,
  updatedAt: r.updated_at,
});

export class HealthRepo {
  constructor(private readonly db: Db) {}

  /** Record the outcome of one provider call. */
  record(
    provider: string,
    label: string,
    result: Availability<unknown>,
    opts: { enabled?: boolean; latencyMs?: number } = {},
  ): void {
    const now = Date.now();
    const enabled = opts.enabled === false ? 0 : 1;
    if (result.available) {
      this.db
        .prepare(
          `INSERT INTO provider_health (provider, label, enabled, last_ok_at, last_latency_ms, ok_count, fail_count, updated_at)
           VALUES (?,?,?,?,?,1,0,?)
           ON CONFLICT (provider) DO UPDATE SET
             label = excluded.label,
             enabled = excluded.enabled,
             last_ok_at = excluded.last_ok_at,
             last_latency_ms = COALESCE(excluded.last_latency_ms, provider_health.last_latency_ms),
             ok_count = provider_health.ok_count + 1,
             updated_at = excluded.updated_at`,
        )
        .run(provider, label, enabled, now, opts.latencyMs ?? null, now);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO provider_health (provider, label, enabled, last_fail_at, last_reason, last_detail, ok_count, fail_count, updated_at)
         VALUES (?,?,?,?,?,?,0,1,?)
         ON CONFLICT (provider) DO UPDATE SET
           label = excluded.label,
           enabled = excluded.enabled,
           last_fail_at = excluded.last_fail_at,
           last_reason = excluded.last_reason,
           last_detail = excluded.last_detail,
           fail_count = provider_health.fail_count + 1,
           updated_at = excluded.updated_at`,
      )
      .run(provider, label, enabled, now, result.reason, result.detail ?? null, now);
  }

  all(): ProviderHealth[] {
    return this.db
      .prepare<[], Row>("SELECT * FROM provider_health ORDER BY provider")
      .all()
      .map(toHealth);
  }

  get(provider: string): ProviderHealth | null {
    const r = this.db
      .prepare<[string], Row>("SELECT * FROM provider_health WHERE provider = ?")
      .get(provider);
    return r ? toHealth(r) : null;
  }
}
