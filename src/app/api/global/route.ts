import { loadGlobal } from "@/lib/market/feed";
import { ok, fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
