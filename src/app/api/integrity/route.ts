import { loadIntegrity } from "@/lib/market/feed";
import { ok, fail, symbolParam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cross-venue price agreement. A recommendation is only as sound as the price
 * it was struck against, so the books we checked are shown to the user.
 */
export async function GET(req: Request) {
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
