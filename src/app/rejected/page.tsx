/**
 * Rejected analyses.
 *
 * Section 7 rule 4 of the specification: show the bad as plainly as the good.
 * This page is the larger half of what the bot does — most analyses end here,
 * and a bot that only displayed its recommendations would be hiding the
 * evidence that its filters work.
 */
import { hasDatabase } from "@/web/db";
import { funnel, rejectedAnalyses } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Num, Panel } from "@/web/components/ui";
import { ago, num, timestamp } from "@/web/format";

export const dynamic = "force-dynamic";

export default function Rejected() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="التحليلات المرفوضة" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const rows = rejectedAnalyses(300);
  const f = funnel(now - 7 * 86_400_000);

  return (
    <>
      <Topbar
        title="التحليلات المرفوضة"
        sub={`${rows.length} تحليل لم يُنتج توصية`}
        right={<span className="sub">النسبة المنطقية: توصية واحدة لكل ٢٠–١٠٠ تحليل</span>}
      />

      <div className="content">
        <Panel title="أين تسقط التحليلات" note="آخر سبعة أيام">
          <div className="funnel">
            {f.stages.map((s) => (
              <div key={s.stage} className="funnel-row">
                <span className="n">{s.number}</span>
                <span className="nm">{s.name}</span>
                <span className="ct">{s.rejected}</span>
                <span className="bar">
                  <span className="fill" style={{ width: `${f.analyzed > 0 ? (s.rejected / f.analyzed) * 100 : 0}%` }} />
                </span>
              </div>
            ))}
            <div className="funnel-row survived">
              <span className="n">✓</span>
              <span className="nm" style={{ color: "var(--text)" }}>نجت وأنتجت توصية</span>
              <span className="ct">{f.recommendations}</span>
              <span className="bar">
                <span className="fill" style={{ width: `${f.analyzed > 0 ? (f.recommendations / f.analyzed) * 100 : 0}%` }} />
              </span>
            </div>
          </div>
          <div className={`verdict ${f.verdict === "healthy" ? "good" : f.verdict === "too_loose" ? "bad" : "warn"}`}>
            {f.arabic}
          </div>
        </Panel>

        <Panel title="كل رفض، وسببه بالضبط">
          {rows.length === 0 ? (
            <div className="panel-body"><div className="empty">لم يُسجَّل أي رفض بعد.</div></div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>العملة</th><th>الإطار</th><th>المرحلة</th><th>السبب</th><th>النتيجة</th><th>الوقت</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="primary"><Num>{r.symbol}</Num></td>
                      <td><Num>{r.timeframe}</Num></td>
                      <td>
                        <span className="chip"><span className="sym">{r.failedNumber}</span></span>{" "}
                        {stageName(r.failedStage)}
                      </td>
                      <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px", maxWidth: 520 }}>
                        {r.reason}
                      </td>
                      <td><Num>{r.finalScore != null ? num(r.finalScore, 0) : "—"}</Num></td>
                      <td style={{ color: "var(--text-3)" }}>{ago(r.analyzedAt, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function stageName(id: string): string {
  const map: Record<string, string> = {
    eligibility: "فلتر الأهلية", macro: "السياق الكلي", technical: "التحليل الفني",
    structure: "الهيكل والمستويات", flows: "التدفّقات", onchain: "بيانات السلسلة",
    sentiment: "المشاعر والأخبار", council: "المجلس النهائي",
  };
  return map[id] ?? id;
}
