import { loadMarkets } from "@/lib/market/feed";
import { ok, fail, intParam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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
