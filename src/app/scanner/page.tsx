/**
 * The scanner.
 *
 * Every symbol in the universe with what the bot last concluded about it —
 * whether that was a recommendation or a rejection. The rejections are the
 * majority and belong in the same table, not on a separate page, because
 * "why is nothing happening on ETH" is answered by the row, not by an absence.
 */
import Link from "next/link";
import { hasDatabase } from "@/web/db";
import {
  candleCoverage, recentRecommendations, rejectedAnalyses, symbols,
} from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Num, Panel } from "@/web/components/ui";
import { ago, dateOnly, int, num } from "@/web/format";
import { SETUP_AR, type SetupKind } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

export default function Scanner() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="الماسح" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const universe = symbols(500);
  const recs = recentRecommendations(500);
  const rejects = rejectedAnalyses(2000);
  const coverage = candleCoverage(2000);

  // Latest verdict per symbol — a recommendation outranks a rejection.
  const latestRec = new Map<string, (typeof recs)[number]>();
  for (const r of recs) if (!latestRec.has(r.symbol)) latestRec.set(r.symbol, r);

  const latestReject = new Map<string, (typeof rejects)[number]>();
  for (const r of rejects) if (!latestReject.has(r.symbol)) latestReject.set(r.symbol, r);

  const barsBySymbol = new Map<string, number>();
  for (const c of coverage) barsBySymbol.set(c.symbol, (barsBySymbol.get(c.symbol) ?? 0) + c.bars);

  const rows = universe
    .map((s) => {
      const rec = latestRec.get(s.symbol);
      const rej = latestReject.get(s.symbol);
      const analyzedAt = rec ? rec.generatedAt : rej?.analyzedAt ?? null;
      return {
        symbol: s.symbol,
        status: s.status,
        listedAt: s.listedAt,
        bars: barsBySymbol.get(s.symbol) ?? 0,
        rec: rec ?? null,
        reject: rej ?? null,
        analyzedAt,
        score: rec?.finalScore ?? rej?.finalScore ?? null,
      };
    })
    .sort((a, b) => {
      // Recommendations first, then by score, then by how recently analysed.
      if (a.rec && !b.rec) return -1;
      if (b.rec && !a.rec) return 1;
      if (a.score != null && b.score != null) return Math.abs(b.score) - Math.abs(a.score);
      return (b.analyzedAt ?? 0) - (a.analyzedAt ?? 0);
    });

  const analyzed = rows.filter((r) => r.analyzedAt != null).length;

  return (
    <>
      <Topbar
        title="الماسح"
        sub={`${universe.length} عملة · ${analyzed} حُلّلت · ${latestRec.size} أنتجت توصية`}
      />

      <div className="content">
        {universe.length === 0 ? (
          <Panel title="لا عملات">
            <div className="panel-body">
              <div className="empty">
                لم تُحدَّث قائمة العملات بعد. شغّل <code>npm run backfill -- --top 50</code>
                {" "}ليكتشف العامل العملات من المنصّة حسب حجم التداول الفعلي.
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="كل العملات" note="التوصيات أولاً، ثم الأقوى نتيجةً">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>العملة</th><th>الحالة</th><th>الخلاصة</th><th>النتيجة</th>
                    <th>النمط</th><th>شموع</th><th>مدرجة منذ</th><th>آخر تحليل</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.symbol}>
                      <td className="primary">
                        <Link href={`/coin/${r.symbol}`}><Num>{r.symbol}</Num></Link>
                      </td>
                      <td>
                        {r.status === "trading"
                          ? <span className="chip">متداولة</span>
                          : <span className="chip chip-short">{r.status === "halted" ? "موقوفة" : "مشطوبة"}</span>}
                      </td>
                      <td>
                        {r.rec ? (
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <Direction direction={r.rec.direction} />
                            <Link href={`/recommendations/${r.rec.id}`} style={{ color: "var(--accent)" }}>توصية</Link>
                          </span>
                        ) : r.reject ? (
                          <span style={{ color: "var(--text-3)" }}>
                            سقطت في المرحلة <Num>{r.reject.failedNumber}</Num>
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-3)" }}>لم تُحلَّل بعد</span>
                        )}
                      </td>
                      <td><Num>{r.score != null ? num(r.score, 0) : "—"}</Num></td>
                      <td>{r.rec ? (SETUP_AR[r.rec.setup as SetupKind] ?? r.rec.setup) : "—"}</td>
                      <td><Num>{int(r.bars)}</Num></td>
                      <td><Num>{r.listedAt ? dateOnly(r.listedAt) : "—"}</Num></td>
                      <td style={{ color: "var(--text-3)" }}>{r.analyzedAt ? ago(r.analyzedAt, now) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
