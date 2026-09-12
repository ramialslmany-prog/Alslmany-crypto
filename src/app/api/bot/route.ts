import { loadState, isDurable } from "@/lib/bot/store";
import { computeStats, equityCurve, groupStats } from "@/lib/bot/ledger";
import { DEFAULT_BOT_CONFIG } from "@/lib/bot/types";
import { ok, fail, tooManyRequests } from "@/lib/api";
import { LIMITS, clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The bot's book, its history and the statistics derived from them. */
export async function GET(req: Request) {
  const gate = rateLimit(clientKey(req, "bot"), LIMITS.light.limit, LIMITS.light.windowMs);
  if (!gate.allowed) return tooManyRequests(gate);

  try {
    const state = await loadState();
    return ok(
      {
        open: state.positions,
        closed: state.closed.slice(-100).reverse(),
        events: state.events.slice(-60).reverse(),
        stats: computeStats(state.closed),
        equityR: equityCurve(state.closed),
        bySector: groupStats(state.closed, (p) => p.sector),
        byGrade: groupStats(state.closed, (p) => p.thesis.grade),
        config: DEFAULT_BOT_CONFIG,
        startedAt: state.startedAt,
        lastTickAt: state.lastTickAt,
        // Stated so a reset ledger is never mistaken for a reset strategy.
        durable: isDurable(),
        mode: "paper" as const,
      },
      { fetchedAt: Date.now(), degraded: !isDurable(), note: isDurable() ? undefined : "in-memory ledger — configure Upstash for a durable track record" },
    );
  } catch (err) {
    return fail(err);
  }
}
