/**
 * Live recommendations.
 *
 * A dense table, not a grid of cards: the columns are the comparison. Turning
 * each row into a card would triple its height and destroy the vertical
 * alignment that lets a reader scan eight R-multiples at once.
 */
import Link from "next/link";
import { hasDatabase } from "@/web/db";
import { recentRecommendations, recommendationStates } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Num, Panel } from "@/web/components/ui";
import { ago, num, price, timestamp } from "@/web/format";
import { SETUP_AR, REGIME_AR, type SetupKind, type MarketRegime } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

const LIVE = new Set(["pending", "open", "partial"]);

export default function Recommendations() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="التوصيات المباشرة" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const recs = recentRecommendations(200);
  const states = recommendationStates();
  const live = recs.filter((r) => LIVE.has(states.get(r.id) ?? "pending"));

  return (
    <>
      <Topbar
        title="التوصيات المباشرة"
        sub={`${live.length} نشطة من ${recs.length} مولَّدة`}
        right={<Link href="/history" className="btn">السجل الكامل</Link>}
      />

      <div className="content">
        {live.length === 0 ? (
          <Panel title="لا توصيات نشطة">
            <div className="panel-body">
              <div className="empty">
                <strong>لا شيء نشط الآن — وهذه هي الحالة الغالبة.</strong>
                البوت يرفض معظم ما يحلّله. النسبة المنطقية توصية واحدة لكل عشرين إلى مئة تحليل،
                وإن كانت أكثر من ذلك بكثير فالفلاتر ضعيفة.
                <br /><br />
                صفحة <Link href="/rejected" style={{ color: "var(--accent)" }}>التحليلات المرفوضة</Link> تعرض
                كل عملة حُلّلت، وفي أي مرحلة سقطت، ولماذا بالضبط.
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="نشطة" note="مرتّبة بالثقة">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>العملة</th><th>الاتجاه</th><th>النمط</th><th>النظام</th><th>الإطار</th>
                    <th>منطقة الدخول</th><th>الوقف</th><th>هدف 1</th><th>هدف 2</th><th>هدف 3</th>
                    <th>العائد</th><th>الثقة</th><th>الحالة</th><th>مُولَّدة</th>
                  </tr>
                </thead>
                <tbody>
                  {[...live].sort((a, b) => b.confidence - a.confidence).map((r) => (
                    <tr key={r.id}>
                      <td className="primary">
                        <Link href={`/recommendations/${r.id}`}><Num>{r.symbol}</Num></Link>
                      </td>
                      <td><Direction direction={r.direction} /></td>
                      <td>{SETUP_AR[r.setup as SetupKind] ?? r.setup}</td>
                      <td>{REGIME_AR[r.regime as MarketRegime] ?? r.regime}</td>
                      <td><Num>{r.timeframe}</Num></td>
                      <td className="primary"><Num>{price(r.entryLow)}–{price(r.entryHigh)}</Num></td>
                      <td><Num className="loss">{price(r.stop)}</Num></td>
                      {[0, 1, 2].map((i) => (
                        <td key={i}><Num className="profit">{r.targets[i] ? price(r.targets[i].price) : "—"}</Num></td>
                      ))}
                      <td className="primary"><Num>{num(r.riskReward)}R</Num></td>
                      <td className="primary"><Num>{num(r.confidence, 0)}</Num></td>
                      <td>{stateAr(states.get(r.id) ?? "pending")}</td>
                      <td style={{ color: "var(--text-3)" }}>{ago(r.generatedAt, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel title="آخر ما وُلِّد" note="بغضّ النظر عن الحالة">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>العملة</th><th>الاتجاه</th><th>النمط</th><th>العائد</th><th>الثقة</th><th>الحالة</th><th>الوقت</th></tr>
              </thead>
              <tbody>
                {recs.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td className="primary"><Link href={`/recommendations/${r.id}`}><Num>{r.symbol}</Num></Link></td>
                    <td><Direction direction={r.direction} /></td>
                    <td>{SETUP_AR[r.setup as SetupKind] ?? r.setup}</td>
                    <td><Num>{num(r.riskReward)}R</Num></td>
                    <td><Num>{num(r.confidence, 0)}</Num></td>
                    <td>{stateAr(states.get(r.id) ?? "pending")}</td>
                    <td style={{ color: "var(--text-3)" }}><Num>{timestamp(r.generatedAt)}</Num></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

function stateAr(state: string): string {
  const map: Record<string, string> = {
    pending: "بانتظار الدخول", open: "مفتوحة", partial: "خروج جزئي",
    closed: "مغلقة", expired: "منتهية", invalidated: "ملغاة",
  };
  return map[state] ?? state;
}
