/**
 * CSV export of the full record.
 *
 * Plain CSV rather than a formatted report: the point is that the numbers can
 * be taken elsewhere and checked independently. A track record you cannot
 * export is a track record you have to take on trust.
 */
import { closedPositions, recentRecommendations, recommendationStates } from "@/web/queries";
import { hasDatabase } from "@/web/db";

export const dynamic = "force-dynamic";

const HEADERS = [
  "id", "symbol", "direction", "setup", "regime", "timeframe",
  "generated_at_utc", "confidence", "final_score", "planned_rr",
  "entry_low", "entry_high", "stop", "target_1", "target_2", "target_3",
  "state", "realized_r", "realized_pnl", "exit_reason",
  "max_favorable_r", "max_adverse_r", "bars_held",
];

/** RFC 4180 quoting: a field containing a comma, quote or newline is quoted. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(): Promise<Response> {
  if (!hasDatabase()) {
    return new Response("لا توجد قاعدة بيانات بعد\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const recs = recentRecommendations(5000);
  const states = recommendationStates();
  const positions = new Map(closedPositions(5000).map((p) => [p.recommendationId, p]));

  const lines = [HEADERS.join(",")];

  for (const r of recs) {
    const p = positions.get(r.id);
    lines.push([
      r.id, r.symbol, r.direction, r.setup, r.regime, r.timeframe,
      new Date(r.generatedAt).toISOString(),
      r.confidence, r.finalScore.toFixed(2), r.riskReward.toFixed(3),
      r.entryLow, r.entryHigh, r.stop,
      r.targets[0]?.price ?? "", r.targets[1]?.price ?? "", r.targets[2]?.price ?? "",
      states.get(r.id) ?? "pending",
      p?.realizedR?.toFixed(4) ?? "", p?.realizedPnl?.toFixed(4) ?? "", p?.exitReason ?? "",
      p?.maxFavorableR?.toFixed(4) ?? "", p?.maxAdverseR?.toFixed(4) ?? "", p?.barsHeld ?? "",
    ].map(csvField).join(","));
  }

  // The BOM makes Excel open UTF-8 correctly instead of mangling the Arabic.
  const body = `﻿${lines.join("\n")}\n`;

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="alslmany-record-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
