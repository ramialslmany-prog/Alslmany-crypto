import { loadSentiment } from "@/lib/market/feed";
import { ok, fail, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "sentiment"), LIMITS.light.limit, LIMITS.light.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  try {
    const r = await loadSentiment();
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
