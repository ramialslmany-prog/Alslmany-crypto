/**
 * The dashboard.
 *
 * Answers, in order: is the bot allowed to trade right now, what is the money
 * doing, is the filter funnel behaving, and what is live. The funnel counter
 * is here rather than buried because it is the honest check on whether the
 * eight stages are doing anything at all.
 */
import Link from "next/link";
import { hasDatabase } from "@/web/db";
import {
  activeBreakers, equityCurve, funnel, livePositions, portfolio,
  providerHealth, recentRecommendations, recommendationStates,
} from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Money, Num, Panel, Stat } from "@/web/components/ui";
import { EquityChart } from "@/web/components/EquityChart";
import { ago, compact, num, pct, price, timestamp } from "@/web/format";
import { SETUP_AR, REGIME_AR, type SetupKind, type MarketRegime } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="لوحة القيادة" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const pf = portfolio();
  const breakers = activeBreakers(now);
  const curve = equityCurve(now - 90 * 86_400_000);
  const live = livePositions();
  const recs = recentRecommendations(60);
  const states = recommendationStates();
  const health = providerHealth();
  const f = funnel(now - 86_400_000);

  const activeRecs = recs
    .filter((r) => ["pending", "open", "partial"].includes(states.get(r.id) ?? "pending"))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);

  const failing = health.filter((h) => h.lastFailAt && (!h.lastOkAt || h.lastFailAt > h.lastOkAt));

  return (
    <>
      <Topbar
        title="لوحة القيادة"
        sub={pf ? `آخر تحديث ${ago(pf.at, now)}` : "بانتظار أول دورة"}
        right={
          <span className="sub">
            التنفيذ ورقي · <Num>{live.length}</Num> مركز مفتوح
          </span>
        }
      />

      <div className="content">
        {breakers.length > 0 && (
          <div className="panel">
            {breakers.map((b) => (
              <div key={b.kind} className="verdict bad">
                <strong style={{ color: "var(--loss)" }}>قاطع حماية مفعّل — </strong>
                {b.arabic}
                {b.requiresManualReset && " لا يستأنف إلا بتشغيل يدوي من صفحة الإعدادات."}
              </div>
            ))}
          </div>
        )}

        <div className="stats">
          <Stat
            label="رأس المال"
            value={pf ? <>{compact(pf.equity)}</> : "—"}
            detail={pf ? <>الذروة {compact(pf.peakEquity)}</> : undefined}
          />
          <Stat
            label="اليوم"
            value={<Money value={pf?.dayPnlPct ?? null} format={(n) => pct(n)} />}
            detail="من رأس مال بداية اليوم"
          />
          <Stat
            label="التراجع من الذروة"
            value={<span className={pf && pf.drawdownPct > 10 ? "loss" : ""}>{pf ? pct(-pf.drawdownPct) : "—"}</span>}
            detail="يتوقّف البوت كلياً عند 15%"
          />
          <Stat
            label="التعرّض"
            value={pf ? <>{compact(pf.exposure)}</> : "—"}
            detail={<>{live.length} من 6 مراكز</>}
          />
        </div>

        <div className="split">
          <Panel title="منحنى رأس المال" note="مقابل شراء البيتكوين والاحتفاظ به">
            {curve.length > 1 ? (
              <EquityChart points={curve} />
            ) : (
              <div className="panel-body">
                <div className="empty">
                  لا توجد نقاط كافية لرسم المنحنى بعد. يحتاج الرسم نقطتين على الأقل من العامل.
                </div>
              </div>
            )}
          </Panel>

          <Panel title="قمع التحليل" note="آخر 24 ساعة">
            <div className="funnel">
              {f.stages.map((s) => {
                const width = f.analyzed > 0 ? (s.rejected / f.analyzed) * 100 : 0;
                return (
                  <div key={s.stage} className="funnel-row">
                    <span className="n">{s.number}</span>
                    <span className="nm">{s.name}</span>
                    <span className="ct">{s.rejected}</span>
                    <span className="bar"><span className="fill" style={{ width: `${width}%` }} /></span>
                  </div>
                );
              })}
              <div className="funnel-row survived">
                <span className="n">✓</span>
                <span className="nm" style={{ color: "var(--text)" }}>أنتجت توصية</span>
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
        </div>

        <Panel
          title="أقوى التوصيات النشطة"
          note={activeRecs.length > 0 ? `${activeRecs.length} نشطة` : undefined}
          actions={<Link href="/recommendations" className="btn">الكل</Link>}
        >
          {activeRecs.length === 0 ? (
            <div className="panel-body">
              <div className="empty">
                لا توجد توصيات نشطة. هذه هي الحالة الغالبة — البوت يرفض معظم ما يحلّله،
                وصفحة <Link href="/rejected" style={{ color: "var(--accent)" }}>التحليلات المرفوضة</Link> تُظهر أين سقط كل منها.
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>العملة</th><th>الاتجاه</th><th>النمط</th><th>الإطار</th>
                    <th>الدخول</th><th>الوقف</th><th>العائد</th><th>الثقة</th><th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRecs.map((r) => (
                    <tr key={r.id}>
                      <td className="primary">
                        <Link href={`/recommendations/${r.id}`}><Num>{r.symbol}</Num></Link>
                      </td>
                      <td><Direction direction={r.direction} /></td>
                      <td>{SETUP_AR[r.setup as SetupKind] ?? r.setup}</td>
                      <td><Num>{r.timeframe}</Num></td>
                      <td className="primary"><Num>{price(r.entryLow)}–{price(r.entryHigh)}</Num></td>
                      <td><Num className="loss">{price(r.stop)}</Num></td>
                      <td><Num className="profit">{num(r.riskReward)}R</Num></td>
                      <td className="primary"><Num>{num(r.confidence, 0)}</Num></td>
                      <td>{stateAr(states.get(r.id) ?? "pending")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid-2">
          <Panel title="حالة السوق" note="من آخر توصية مولَّدة">
            {recs[0] ? (
              <div className="panel-body" style={{ display: "grid", gap: 8, fontSize: 12, color: "var(--text-2)" }}>
                <div>النظام السوقي: <strong style={{ color: "var(--text)" }}>{REGIME_AR[recs[0].regime as MarketRegime] ?? recs[0].regime}</strong></div>
                <div>آخر تحليل أنتج توصية: <Num>{timestamp(recs[0].generatedAt)}</Num> UTC</div>
                <div style={{ color: "var(--text-3)" }}>
                  النظام السوقي يُحدّد أي المؤشرات يُسمح لها بالتصويت. في الاتجاهات تُلغى مؤشرات
                  الانعكاس تماماً، وفي الأسواق العرضية تُلغى مؤشرات الاختراق.
                </div>
              </div>
            ) : (
              <div className="panel-body"><div className="empty">لم تُولَّد أي توصية بعد.</div></div>
            )}
          </Panel>

          <Panel
            title="حالة المصادر"
            actions={<Link href="/health" className="btn">التفاصيل</Link>}
          >
            {health.length === 0 ? (
              <div className="panel-body"><div className="empty">لم يُسجَّل أي فحص للمصادر بعد. شغّل <code>npm run doctor</code>.</div></div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    <tr>
                      <td>مصادر تعمل</td>
                      <td className="primary"><Num>{health.length - failing.length}</Num> من <Num>{health.length}</Num></td>
                    </tr>
                    {failing.slice(0, 4).map((h) => (
                      <tr key={h.provider}>
                        <td style={{ color: "var(--loss)" }}>{h.label}</td>
                        <td>{h.lastReasonAr ?? "خطأ"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function stateAr(state: string): string {
  switch (state) {
    case "pending": return "بانتظار الدخول";
    case "open": return "مفتوحة";
    case "partial": return "خروج جزئي";
    case "closed": return "مغلقة";
    case "expired": return "منتهية";
    case "invalidated": return "ملغاة";
    default: return state;
  }
}
