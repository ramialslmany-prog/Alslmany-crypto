import { loadIntegrity } from "@/lib/market/feed";
import { ok, fail, symbolParam, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cross-venue price agreement. A recommendation is only as sound as the price
 * it was struck against, so the books we checked are shown to the user.
 */
export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "integrity"), LIMITS.light.limit, LIMITS.light.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  const symbol = symbolParam(new URL(req.url));
  try {
    const r = await loadIntegrity(symbol);
    return ok(r.value, {
      fetchedAt: r.fetchedAt,
      degraded: r.degraded || !r.value.trustworthy,
      note: r.note,
    });
  } catch (err) {
    return fail(err);
  }
}
