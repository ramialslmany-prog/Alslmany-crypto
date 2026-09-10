import { runTick } from "@/lib/bot/run";
import { ok, fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The 24/7 scan, driven by a scheduler so the bot keeps working with nobody
 * on the site.
 *
 * Protected by CRON_SECRET. Vercel Cron sends its own bearer token; an
 * external scheduler can pass ?key=. When no secret is configured the endpoint
 * stays closed rather than defaulting to open — an unauthenticated endpoint
 * that mutates a ledger is an invitation.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;

  return new URL(req.url).searchParams.get("key") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return fail(
      process.env.CRON_SECRET?.trim()
        ? "unauthorized"
        : "CRON_SECRET is not configured — the scheduled scan is disabled",
      401,
    );
  }

  try {
    const result = await runTick();
    return ok(
      {
        opened: result.opened.map((p) => p.symbol),
        closed: result.closed.map((p) => ({ symbol: p.symbol, r: p.realizedR, reason: p.exitReason })),
        openCount: result.state.positions.length,
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
