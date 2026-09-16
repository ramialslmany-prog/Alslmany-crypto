/**
 * Performance.
 *
 * Results in R, sliced by setup, timeframe, symbol and regime — and compared
 * against simply holding Bitcoin, because a strategy that underperforms
 * buy-and-hold is a complicated way to lose to a simple one.
 *
 * Every number here comes from closed positions only. Counting open winners
 * is how a track record flatters itself.
 */
import { hasDatabase } from "@/web/db";
import {
  closedPositions, equityCurve, performance, performanceBy, recentRecommendations,
} from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Money, Num, Panel, Stat } from "@/web/components/ui";
import { num, pct, rMultiple } from "@/web/format";
import { SETUP_AR, REGIME_AR, type SetupKind, type MarketRegime } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

export default function Performance() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="الأداء" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const closed = closedPositions(1000);
  const recs = new Map(recentRecommendations(1000).map((r) => [r.id, r]));
  const p = performance(closed);
  const curve = equityCurve(0);

  const maxDrawdown = curve.reduce((m, c) => Math.max(m, c.drawdownPct), 0);

  // Buy and hold over the same window, from the stored Bitcoin prices.
  const withBtc = curve.filter((c) => c.btcPrice != null);
  const btcReturn = withBtc.length > 1 && withBtc[0].btcPrice
    ? ((withBtc[withBtc.length - 1].btcPrice! - withBtc[0].btcPrice!) / withBtc[0].btcPrice!) * 100
    : null;
  const botReturn = curve.length > 1 && curve[0].equity > 0
    ? ((curve[curve.length - 1].equity - curve[0].equity) / curve[0].equity) * 100
    : null;

  const slices = [
    { title: "حسب نمط الصفقة", rows: performanceBy(closed, recs, "setup"), label: (k: string) => SETUP_AR[k as SetupKind] ?? k },
    { title: "حسب الإطار الزمني", rows: performanceBy(closed, recs, "timeframe"), label: (k: string) => k },
    { title: "حسب حالة السوق", rows: performanceBy(closed, recs, "regime"), label: (k: string) => REGIME_AR[k as MarketRegime] ?? k },
    { title: "حسب العملة", rows: performanceBy(closed, recs, "symbol").slice(0, 15), label: (k: string) => k },
  ];

  const maxCount = Math.max(1, ...p.distribution.map((d) => d.count));

  return (
    <>
      <Topbar title="الأداء" sub={`${p.trades} صفقة مغلقة`} right={<span className="sub">المفتوحة غير محتسبة</span>} />

      <div className="content">
        {p.trades === 0 ? (
          <Panel title="لا نتائج بعد">
            <div className="panel-body">
              <div className="empty">
                <strong>لم تُغلق أي صفقة بعد.</strong>
                الأرقام هنا تُحتسب من الصفقات المغلقة فقط — احتساب الرابحة المفتوحة
                هو كيف يُجمّل السجلّ نفسه.
              </div>
            </div>
          </Panel>
        ) : (
          <>
            <div className="stats">
              <Stat label="نسبة الربح" value={<>{num(p.winRate * 100, 1)}%</>} detail={<>{p.wins} رابحة · {p.losses} خاسرة</>} />
              <Stat
                label="عامل الربح"
                value={p.profitFactor != null ? num(p.profitFactor) : "—"}
                detail="إجمالي الربح ÷ إجمالي الخسارة"
              />
              <Stat label="التوقّع" value={<Money value={p.expectancyR} format={rMultiple} />} detail="لكل صفقة" />
              <Stat label="أقصى تراجع" value={<span className="loss">{pct(-maxDrawdown)}</span>} detail="من الذروة" />
            </div>

            <Panel title="مقابل شراء البيتكوين والاحتفاظ به" note="على نفس النافذة الزمنية">
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    <tr>
                      <td className="primary">البوت</td>
                      <td><Money value={botReturn} format={(n) => pct(n)} /></td>
                      <td style={{ color: "var(--text-3)" }}>
                        بعد الرسوم والانزلاق، على {p.trades} صفقة
                      </td>
                    </tr>
                    <tr>
                      <td className="primary">شراء البيتكوين والاحتفاظ</td>
                      <td><Money value={btcReturn} format={(n) => pct(n)} /></td>
                      <td style={{ color: "var(--text-3)" }}>
                        {btcReturn == null ? "سعر البيتكوين غير مسجّل مع نقاط المنحنى" : "بلا رسوم ولا قرارات"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {botReturn != null && btcReturn != null && (
                <div className={`verdict ${botReturn > btcReturn ? "good" : "bad"}`}>
                  {botReturn > btcReturn
                    ? `البوت متقدّم على الاحتفاظ بفارق ${num(botReturn - btcReturn, 2)} نقطة مئوية.`
                    : `الاحتفاظ متقدّم على البوت بفارق ${num(btcReturn - botReturn, 2)} نقطة مئوية — ` +
                      `استراتيجية تخسر أمام الاحتفاظ هي طريقة معقّدة للخسارة أمام طريقة بسيطة.`}
                </div>
              )}
            </Panel>

            <div className="split">
              <Panel title="توزيع النتائج" note="بوحدات المخاطرة">
                <div className="funnel">
                  {p.distribution.map((d) => (
                    <div key={d.bucket} className="funnel-row">
                      <span className="n" />
                      <span className="nm"><Num>{d.bucket}</Num></span>
                      <span className="ct">{d.count}</span>
                      <span className="bar">
                        <span
                          className="fill"
                          style={{
                            width: `${(d.count / maxCount) * 100}%`,
                            background: d.bucket.startsWith("−") || d.bucket.startsWith("<") ? "var(--loss)" : "var(--profit)",
                            opacity: 0.6,
                          }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="متوسطات">
                <div className="table-scroll">
                  <table className="table">
                    <tbody>
                      <tr><td>متوسط الرابحة</td><td><Money value={p.avgWinR} format={rMultiple} /></td></tr>
                      <tr><td>متوسط الخاسرة</td><td><Money value={p.avgLossR} format={rMultiple} /></td></tr>
                      <tr><td>مجموع النتائج</td><td><Money value={p.totalR} format={rMultiple} /></td></tr>
                      <tr>
                        <td>أقصى ربح عائم متوسط</td>
                        <td><Num>{num(closed.reduce((s, x) => s + x.maxFavorableR, 0) / closed.length)}R</Num></td>
                      </tr>
                      <tr>
                        <td>أقصى خسارة عائمة متوسطة</td>
                        <td><Num className="loss">{num(closed.reduce((s, x) => s + x.maxAdverseR, 0) / closed.length)}R</Num></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>

            {slices.map((slice) => (
              <Panel key={slice.title} title={slice.title}>
                <div className="table-scroll">
                  <table className="table">
                    <thead><tr><th>—</th><th>صفقات</th><th>نسبة الربح</th><th>التوقّع</th><th>المجموع</th></tr></thead>
                    <tbody>
                      {slice.rows.map((r) => (
                        <tr key={r.key}>
                          <td className="primary">{slice.label(r.key)}</td>
                          <td><Num>{r.trades}</Num></td>
                          <td><Num>{num(r.winRate * 100, 0)}%</Num></td>
                          <td><Money value={r.expectancyR} format={rMultiple} /></td>
                          <td><Money value={r.totalR} format={rMultiple} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}
          </>
        )}
      </div>
    </>
  );
}
