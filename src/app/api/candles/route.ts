import { loadSeries } from "@/lib/market/feed";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { ok, fail, enumParam, intParam, symbolParam } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = symbolParam(url);
  const timeframe = enumParam<Timeframe>(url, "tf", TIMEFRAMES, "1h");
  const limit = intParam(url, "limit", 300, 60, 1000);

  try {
    const r = await loadSeries(symbol, timeframe, limit);
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
