import { loadGlobal } from "@/lib/market/feed";
import { ok, fail, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "global"), LIMITS.light.limit, LIMITS.light.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  try {
    const r = await loadGlobal();
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
