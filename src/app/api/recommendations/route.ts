import { scanMarket } from "@/lib/engine/scan";
import { cached } from "@/lib/market/cache";
import { ok, fail, intParam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The ranked recommendation set.
 *
 * A full scan is expensive — one multi-timeframe stack per asset — so results
 * are cached for a couple of minutes. That is well inside the horizon of every
 * setup published here; nothing on a 4h chart changes meaningfully in 120
 * seconds, and hammering three exchanges for the illusion of freshness would
 * only get us rate-limited.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tier = intParam(url, "tier", 2, 1, 3) as 1 | 2 | 3;
  const limit = intParam(url, "limit", 60, 1, 60);

  try {
    const result = await cached(`scan:${tier}:${limit}`, 120_000, () =>
      scanMarket({ maxTier: tier, limit }),
    );
    return ok(result.value, {
      // Without the source the banner cannot tell "stale but real" from
      // "generated" — and those must never look the same to a reader.
      source: result.value.source,
      fetchedAt: result.fetchedAt,
      degraded: result.degraded || result.value.degraded,
      note: result.note,
    });
  } catch (err) {
    return fail(err);
  }
}
