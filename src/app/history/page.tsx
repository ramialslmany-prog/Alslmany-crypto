/**
 * The full record.
 *
 * Every recommendation ever generated with its outcome, plus the relationship
 * between confidence and result. That scatter is the single most useful chart
 * on the site: if high-confidence calls do not outperform low-confidence ones,
 * the confidence number is decoration and should be rebuilt.
 */
import Link from "next/link";
import { hasDatabase } from "@/web/db";
import { closedPositions, recentRecommendations, recommendationStates } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Money, Num, Panel } from "@/web/components/ui";
import { ConfidenceScatter } from "@/web/components/ConfidenceScatter";
import { num, rMultiple, timestamp } from "@/web/format";
import { SETUP_AR, type SetupKind } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

export default function History() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="السجل" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const recs = recentRecommendations(500);
  const states = recommendationStates();
  const closed = closedPositions(1000);
  const byRec = new Map(closed.map((p) => [p.recommendationId, p]));

  const paired = recs
    .map((r) => ({ rec: r, pos: byRec.get(r.id) ?? null }))
    .filter((x) => x.pos !== null) as { rec: (typeof recs)[number]; pos: NonNullable<ReturnType<typeof byRec.get>> }[];

  return (
    <>
      <Topbar
        title="السجل"
        sub={`${recs.length} توصية · ${paired.length} أُغلقت`}
        right={<a className="btn" href="/api/export" download>تصدير CSV</a>}
      />

      <div className="content">
        <Panel
          title="الثقة مقابل النتيجة"
          note="إن لم تتفوّق التوصيات عالية الثقة، فالثقة رقم زخرفي"
        >
          {paired.length >= 3 ? (
            <ConfidenceScatter
              points={paired.map((x) => ({
                confidence: x.rec.confidence,
                r: x.pos.realizedR,
                symbol: x.rec.symbol,
              }))}
            />
          ) : (
            <div className="panel-body">
              <div className="empty">
                تحتاج ثلاث صفقات مغلقة على الأقل لرسم العلاقة. المتاح الآن {paired.length}.
              </div>
            </div>
          )}
        </Panel>

        <Panel title="كل التوصيات">
          {recs.length === 0 ? (
            <div className="panel-body"><div className="empty">لم تُولَّد أي توصية بعد.</div></div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>العملة</th><th>الاتجاه</th><th>النمط</th><th>الإطار</th>
                    <th>الثقة</th><th>العائد المخطّط</th><th>النتيجة</th>
                    <th>سبب الخروج</th><th>المدة</th><th>الحالة</th><th>الوقت</th>
                  </tr>
                </thead>
                <tbody>
                  {recs.map((r) => {
                    const pos = byRec.get(r.id) ?? null;
                    return (
                      <tr key={r.id}>
                        <td className="primary"><Link href={`/recommendations/${r.id}`}><Num>{r.symbol}</Num></Link></td>
                        <td><Direction direction={r.direction} /></td>
                        <td>{SETUP_AR[r.setup as SetupKind] ?? r.setup}</td>
                        <td><Num>{r.timeframe}</Num></td>
                        <td><Num>{num(r.confidence, 0)}</Num></td>
                        <td><Num>{num(r.riskReward)}R</Num></td>
                        <td>{pos ? <Money value={pos.realizedR} format={rMultiple} /> : <span style={{ color: "var(--text-3)" }}>—</span>}</td>
                        <td>{pos?.exitReason ? exitAr(pos.exitReason) : "—"}</td>
                        <td><Num>{pos ? `${pos.barsHeld}` : "—"}</Num></td>
                        <td>{stateAr(states.get(r.id) ?? "pending")}</td>
                        <td style={{ color: "var(--text-3)" }}><Num>{timestamp(r.generatedAt)}</Num></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function stateAr(s: string): string {
  const map: Record<string, string> = {
    pending: "بانتظار", open: "مفتوحة", partial: "جزئي",
    closed: "مغلقة", expired: "منتهية", invalidated: "ملغاة",
  };
  return map[s] ?? s;
}

function exitAr(reason: string): string {
  const map: Record<string, string> = {
    target_1: "الهدف الأول", target_2: "الهدف الثاني", target_3: "الهدف الثالث",
    stop_loss: "الوقف", breakeven_stop: "وقف التعادل", trailing_stop: "وقف متتبّع",
    invalidated: "إبطال", time_exit: "خروج زمني", circuit_breaker: "قاطع حماية", manual: "يدوي",
  };
  return map[reason] ?? reason;
}
