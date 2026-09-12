import { loadMarkets } from "@/lib/market/feed";
import { ok, fail, intParam, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "markets"), LIMITS.light.limit, LIMITS.light.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  const limit = intParam(new URL(req.url), "limit", 250, 10, 250);
  try {
    const r = await loadMarkets(limit);
    return ok(r.data, {
      source: r.source,
      fetchedAt: r.fetchedAt,
      degraded: r.degraded,
      note: r.note,
    });
  } catch (err) {
    return fail(err);
  }
}
