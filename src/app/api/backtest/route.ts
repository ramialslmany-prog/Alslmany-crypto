import { backtest } from "@/lib/bot/backtest";
import { loadSeries } from "@/lib/market/feed";
import { lookupSymbol } from "@/lib/market/universe";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { cached } from "@/lib/market/cache";
import { ok, fail, badRequest, enumParam, intParam, symbolParam, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Walk the live strategy over real history.
 *
 * This is what makes the published track record checkable rather than merely
 * asserted — it runs the same engine the bot runs, with no look-ahead and with
 * slippage charged against us.
 */
export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "backtest"), LIMITS.backtest.limit, LIMITS.backtest.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  const url = new URL(req.url);
  const symbol = symbolParam(url);
  const timeframe = enumParam<Timeframe>(url, "tf", TIMEFRAMES, "4h");
  const bars = intParam(url, "bars", 1000, 400, 1000);

  const entry = lookupSymbol(symbol);
  if (!entry) return badRequest(`${symbol} is not in the tracked universe`);

  try {
    const result = await cached(`backtest:${symbol}:${timeframe}:${bars}`, 10 * 60_000, async () => {
      const [own, btc] = await Promise.all([
        loadSeries(symbol, timeframe, bars),
        loadSeries("BTC", timeframe, bars).catch(() => null),
      ]);
      const run = await backtest({
        entry,
        candles: own.data.candles,
        timeframe,
        btcCandles: btc?.data.candles ?? null,
        stride: 2,
      });
      return { run, source: own.data.source };
    });

    return ok(result.value.run, {
      source: result.value.source,
      fetchedAt: result.fetchedAt,
      degraded: result.degraded || result.value.source === "synthetic",
      note:
        result.value.source === "synthetic"
          ? "backtested on demo data — results are illustrative only"
          : result.note,
    });
  } catch (err) {
    return fail(err);
  }
}
