import { runTick } from "@/lib/bot/run";
import { ok, fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Advance the bot one tick.
 *
 * POST only: this mutates the ledger, and a GET that changes state gets fired
 * by every crawler and link preview that touches it.
 */
export async function POST() {
  try {
    const result = await runTick();
    return ok(
      {
        opened: result.opened,
        closed: result.closed,
        refused: result.refused,
        open: result.state.positions,
        marketRegime: result.marketRegime,
        riskBudget: result.riskBudget,
        notified: result.notified,
        durable: result.durable,
      },
      { fetchedAt: Date.now(), degraded: result.degraded },
    );
  } catch (err) {
    return fail(err);
  }
}
