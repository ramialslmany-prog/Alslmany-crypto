import { analyzeSymbol } from "@/lib/engine/scan";
import { lookupSymbol, isSignalEligible } from "@/lib/market/universe";
import { cached } from "@/lib/market/cache";
import { ok, fail, badRequest, symbolParam, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Deep dive on a single asset. */
export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "analyze"), LIMITS.analyze.limit, LIMITS.analyze.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  const symbol = symbolParam(new URL(req.url));
  const entry = lookupSymbol(symbol);

  if (!entry) return badRequest(`${symbol} is not in the tracked universe`);
  if (!isSignalEligible(symbol)) {
    return badRequest(`${symbol} is a stable or wrapped asset — no directional analysis`);
  }

  try {
    const result = await cached(`analyze:${symbol}`, 90_000, () => analyzeSymbol(entry));
    return ok(result.value, {
      fetchedAt: result.fetchedAt,
      degraded: result.degraded || (result.value.recommendation?.degraded ?? false),
      note: result.note,
    });
  } catch (err) {
    return fail(err);
  }
}
