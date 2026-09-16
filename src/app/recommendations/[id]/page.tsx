/**
 * One recommendation, in full.
 *
 * The page exists to answer "how did the bot reach this decision", so the
 * eight-stage timeline is the body of it, not an appendix. Unavailable stages
 * appear with the confidence penalty they caused; hiding them would present a
 * partial analysis as a complete one.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasDatabase } from "@/web/db";
import { pipelineRun, recommendation, recommendationEvents } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Money, Num, Panel } from "@/web/components/ui";
import { StageTimeline, type TimelineStage } from "@/web/components/StageTimeline";
import { TradeChart } from "@/web/components/TradeChart";
import { num, price, timestamp } from "@/web/format";
import { SETUP_AR, REGIME_AR, type SetupKind, type MarketRegime } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

interface RunShape {
  stages?: TimelineStage[];
  vetoes?: { id: string; arabic: string; actual: string; threshold: string }[];
  setup?: { arabic: string } | null;
  regime?: string | null;
}

export default async function RecommendationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // No database means the worker has not run; no record with that id is a
  // genuine 404. Conflating them sends an operator hunting for a bad link.
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="التوصية" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const rec = recommendation(id);
  if (!rec) notFound();

  const run = pipelineRun(id) as RunShape | null;
  const events = recommendationEvents(id);
  const stages = run?.stages ?? [];

  return (
    <>
      <Topbar
        title={rec.symbol}
        sub={`${SETUP_AR[rec.setup as SetupKind] ?? rec.setup} · ${REGIME_AR[rec.regime as MarketRegime] ?? rec.regime} · إطار ${rec.timeframe}`}
        right={
          <>
            <Direction direction={rec.direction} />
            <span className="sub">
              مُولَّدة <Num>{timestamp(rec.generatedAt)}</Num> UTC
            </span>
          </>
        }
      />

      <div className="content">
        {/* ── the plan ──────────────────────────────────────────────────── */}
        <Panel title="خطة الصفقة">
          <div className="plan">
            <div className="plan-cell">
              <div className="k">منطقة الدخول</div>
              <div className="v">{price(rec.entryLow)} – {price(rec.entryHigh)}</div>
              <div className="why">نطاق من مستوى فعلي، لا سعر واحد — السعر لا ينعكس عند نقطة بعينها</div>
            </div>
            <div className="plan-cell">
              <div className="k">الوقف</div>
              <div className="v loss">{price(rec.stop)}</div>
              <div className="why">{rec.stopBasis}</div>
            </div>
            <div className="plan-cell">
              <div className="k">العائد للمخاطرة</div>
              <div className="v profit">{num(rec.riskReward)}R</div>
              <div className="why">مرجّح عبر الخروج التدريجي، لا مقيس إلى الهدف الثالث — القياس إلى الأخير يُجمّل كل صفقة</div>
            </div>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>الهدف</th><th>السعر</th><th>يُغلق</th><th>العائد</th><th>الأساس</th></tr>
              </thead>
              <tbody>
                {rec.targets.map((t) => (
                  <tr key={t.index}>
                    <td className="primary">{["الأول", "الثاني", "الثالث"][t.index - 1]}</td>
                    <td className="primary"><Num>{price(t.price)}</Num></td>
                    <td><Num>{num(t.closeFraction * 100, 0)}%</Num></td>
                    <td><Num className="profit">{num(t.rMultiple)}R</Num></td>
                    <td>{t.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-scroll">
            <table className="table">
              <tbody>
                <tr>
                  <td>حجم المركز</td><td className="primary"><Num>{num(rec.positionSize, 6)}</Num></td>
                  <td>القيمة الاسمية</td><td className="primary"><Num>{num(rec.positionNotional)}</Num></td>
                </tr>
                <tr>
                  <td>المخاطرة</td><td className="primary"><Num>{num(rec.riskAmount)}</Num></td>
                  <td>تنتهي الصلاحية</td><td className="primary"><Num>{timestamp(rec.expiresAt)}</Num> UTC</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── the chart with the plan drawn on it ───────────────────────── */}
        <Panel title="الشارت" note="منطقة الدخول والوقف والأهداف الثلاثة">
          <TradeChart
            symbol={rec.symbol}
            timeframe={rec.timeframe}
            direction={rec.direction}
            entryLow={rec.entryLow}
            entryHigh={rec.entryHigh}
            stop={rec.stop}
            targets={rec.targets.map((t) => t.price)}
            asOf={rec.generatedAt}
          />
        </Panel>

        {/* ── how the bot decided ───────────────────────────────────────── */}
        <Panel
          title="كيف وصل البوت لهذا القرار"
          note={`${stages.length} مرحلة · المراحل غير المتاحة معروضة لا مخفيّة`}
        >
          {stages.length > 0 ? (
            <StageTimeline stages={stages} />
          ) : (
            <div className="panel-body">
              <div className="empty">لم يُخزَّن سجلّ المراحل مع هذه التوصية.</div>
            </div>
          )}
        </Panel>

        <div className="split">
          {/* ── confidence, decomposed ─────────────────────────────────── */}
          <Panel title="الثقة" note="مفكَّكة بمساهمة كل مرحلة">
            <div className="conf-block">
              <div className="conf-head">
                <span className="conf-value">{num(rec.confidence, 0)}</span>
                <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                  من <Num>100</Num> · النتيجة النهائية <Num>{num(rec.finalScore, 0)}</Num>
                </span>
              </div>
              <div className="conf-rows">
                {rec.confidenceComponents.map((c) => {
                  const available = c.status === "pass";
                  const width = available ? Math.min(100, Math.abs(c.score)) : 100;
                  return (
                    <div key={c.stage} className={`conf-row ${available ? "" : "na"}`}>
                      <span className="nm">{c.name}</span>
                      <span className="bar">
                        <span className={`fill ${available ? "" : "na"}`} style={{ width: `${width}%` }} />
                      </span>
                      <span className="val">
                        {available ? `${c.score > 0 ? "+" : "−"}${num(Math.abs(c.score), 0)}` : "غير متاحة"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </Panel>

          {/* ── invalidation ──────────────────────────────────────────── */}
          <Panel title="شروط الإبطال" note="تُفحص آلياً عند كل إغلاق شمعة">
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  {rec.invalidation.map((c) => (
                    <tr key={c.id}><td style={{ whiteSpace: "normal", height: "auto", padding: "8px 12px" }}>{c.arabic}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        {/* ── the narrative ─────────────────────────────────────────────── */}
        <Panel title="التقرير" note="المراحل الثماني في سرد واحد">
          <div className="report-prose">{rec.report}</div>
        </Panel>

        {/* ── the immutable event log ───────────────────────────────────── */}
        <Panel
          title="سجلّ الأحداث"
          note="التوصية لا تُعدَّل ولا تُحذف — كل تغيّر حدث منفصل"
        >
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>الوقت</th><th>الحدث</th><th>السعر</th><th>التفصيل</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td><Num>{timestamp(e.at)}</Num></td>
                    <td className="primary">{eventAr(e.kind)}</td>
                    <td><Num>{e.price != null ? price(e.price) : "—"}</Num></td>
                    <td style={{ whiteSpace: "normal" }}>{e.arabic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="verdict">
            بصمة السلامة <Num>{rec.integrityHash.slice(0, 16)}…</Num> —
            صفٌّ لا يطابق بصمته يعني أنه عُدِّل خارج المسار المسموح.
          </div>
        </Panel>

        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/recommendations" className="btn">كل التوصيات</Link>
          <Link href={`/coin/${rec.symbol}`} className="btn">تحليل {rec.symbol} العميق</Link>
        </div>
      </div>
    </>
  );
}

function eventAr(kind: string): string {
  const map: Record<string, string> = {
    created: "أُنشئت", entry_filled: "نُفّذ الدخول", target_hit: "بلوغ هدف",
    stop_hit: "ضرب الوقف", invalidated: "إبطال", expired: "انتهاء صلاحية",
    stop_moved: "نقل الوقف", partial_exit: "خروج جزئي", closed: "إغلاق", note: "ملاحظة",
  };
  return map[kind] ?? kind;
}
