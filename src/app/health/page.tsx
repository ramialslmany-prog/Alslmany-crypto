/**
 * Health.
 *
 * Every source, when it last answered, what it said when it failed, and where
 * the candle history has holes. A gap is not cosmetic: an indicator computed
 * across one treats two non-adjacent bars as consecutive.
 */
import { hasDatabase } from "@/web/db";
import {
  archiveSummary, candleCoverage, openGaps, providerHealth, unverifiedArchiveCount,
  workerHeartbeat,
} from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Num, Panel, Stat } from "@/web/components/ui";
import { getConfig } from "@/shared/config";
import { ago, dateOnly, int, timestamp } from "@/web/format";

export const dynamic = "force-dynamic";

export default function Health() {
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title="الصحة" />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const cfg = getConfig();
  const health = providerHealth();
  const gaps = openGaps(60);
  const coverage = candleCoverage(120);
  const archive = archiveSummary();
  const unverified = unverifiedArchiveCount();
  const worker = workerHeartbeat();

  const failing = health.filter((h) => h.lastFailAt && (!h.lastOkAt || h.lastFailAt > h.lastOkAt));
  const totalBars = coverage.reduce((s, c) => s + c.bars, 0);

  return (
    <>
      <Topbar title="الصحة" sub={`المنصّة ${cfg.MARKET_EXCHANGE}`} />

      <div className="content">
        <div className="stats">
          <Stat label="مصادر تعمل" value={<>{health.length - failing.length}/{health.length}</>} />
          <Stat label="شموع مخزّنة" value={int(totalBars)} detail={`${coverage.length} سلسلة`} />
          <Stat label="فجوات مفتوحة" value={<span className={gaps.length > 0 ? "loss" : ""}>{gaps.length}</span>} detail="ثقوب في التاريخ" />
          <Stat
            label="ملفات أرشيف بلا تحقّق"
            value={<span className={unverified > 0 ? "loss" : ""}>{unverified}</span>}
            detail="بصمة SHA-256 لم تُطابَق"
          />
        </div>

        <Panel title="العامل" note="نبض البوت نفسه — لا يُستنتج من عمر الشموع">
          <div className="panel-body">
            {worker === null ? (
              <div className="empty">
                لم يعمل العامل بعد على هذه القاعدة. شغّل <code>npm run bot</code>.
                شموع قديمة وحدها لا تفرّق بين عامل متوقّف ومنصّة متوقّفة — لذلك يسجّل العامل نبضه بنفسه.
              </div>
            ) : (
              <table className="table">
                <tbody>
                  <tr>
                    <th>آخر دورة</th>
                    <td>
                      <Num>{timestamp(worker.lastTickAt)}</Num>
                      <span className="muted"> · {ago(worker.lastTickAt, now)}</span>
                      {now - worker.lastTickAt > 2 * 3_600_000 && (
                        <span className="loss"> — متأخّر أكثر من ساعتين</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>مدّة الدورة</th>
                    <td><Num>{int(worker.lastTickMs)}</Num> مللي ثانية</td>
                  </tr>
                  <tr>
                    <th>يعمل منذ</th>
                    <td><Num>{timestamp(worker.startedAt)}</Num> · <Num>{int(worker.ticks)}</Num> دورة</td>
                  </tr>
                  <tr>
                    <th>القمع منذ التشغيل</th>
                    <td>
                      <Num>{int(worker.analyses)}</Num> تحليلاً ·{" "}
                      <Num>{int(worker.recommendations)}</Num> توصية
                      {worker.recommendations > 0 && (
                        <span className="muted">
                          {" "}· واحدة لكل <Num>{int(Math.round(worker.analyses / worker.recommendations))}</Num>
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th>آخر خطأ</th>
                    <td>{worker.lastError ? <span className="loss">{worker.lastError}</span> : <span className="muted">لا شيء</span>}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="المصادر" note="آخر استجابة وسببها">
          {health.length === 0 ? (
            <div className="panel-body">
              <div className="empty">
                لم يُسجَّل أي فحص. شغّل <code>npm run doctor</code> ليُثبت حالة كل مصدر فعلياً.
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>المصدر</th><th>الحالة</th><th>آخر نجاح</th><th>آخر فشل</th><th>السبب</th><th>الزمن</th><th>نجاح/فشل</th></tr>
                </thead>
                <tbody>
                  {health.map((h) => {
                    const down = h.lastFailAt && (!h.lastOkAt || h.lastFailAt > h.lastOkAt);
                    return (
                      <tr key={h.provider}>
                        <td className="primary">{h.label}</td>
                        <td>
                          <span className={`chip ${down ? "chip-short" : "chip-info"}`}>
                            {down ? "متعطّل" : "يعمل"}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-3)" }}>{h.lastOkAt ? ago(h.lastOkAt, now) : "—"}</td>
                        <td style={{ color: "var(--text-3)" }}>{h.lastFailAt ? ago(h.lastFailAt, now) : "—"}</td>
                        <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px" }}>
                          {h.lastReasonAr ?? "—"}
                        </td>
                        <td><Num>{h.lastLatencyMs != null ? `${h.lastLatencyMs}ms` : "—"}</Num></td>
                        <td><Num>{h.okCount}/{h.failCount}</Num></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="split">
          <Panel title="فجوات التاريخ" note="شمعة مفقودة تجعل المؤشر يعامل شمعتين متباعدتين كأنهما متتاليتان">
            {gaps.length === 0 ? (
              <div className="panel-body"><div className="empty">لا فجوات مفتوحة.</div></div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>العملة</th><th>الإطار</th><th>مفقود</th><th>من</th><th>إلى</th></tr></thead>
                  <tbody>
                    {gaps.map((g, i) => (
                      <tr key={i}>
                        <td className="primary"><Num>{g.symbol}</Num></td>
                        <td><Num>{g.timeframe}</Num></td>
                        <td><Num className="loss">{g.missingBars}</Num></td>
                        <td><Num>{dateOnly(g.gapStart)}</Num></td>
                        <td><Num>{dateOnly(g.gapEnd)}</Num></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="الأرشيف التاريخي">
            {archive.length === 0 ? (
              <div className="panel-body">
                <div className="empty">
                  لم يُنزَّل أي أرشيف. <code>npm run backfill -- --top 30 --years 2</code>
                </div>
              </div>
            ) : (
              <>
                <div className="table-scroll">
                  <table className="table">
                    <thead><tr><th>الحالة</th><th>ملفات</th><th>شموع</th></tr></thead>
                    <tbody>
                      {archive.map((a) => (
                        <tr key={a.status}>
                          <td className="primary">{archiveStatusAr(a.status)}</td>
                          <td><Num>{int(a.count)}</Num></td>
                          <td><Num>{int(a.rows)}</Num></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {unverified > 0 && (
                  <div className="verdict warn">
                    <Num>{unverified}</Num> ملف استُورد دون التحقّق من بصمته. البيانات مستخدمة لكنها
                    غير مُثبتة — ملف مبتور يبقى صالحاً ويُحلَّل، ويبدو تاريخاً حقيقياً وهو ناقص.
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>

        <Panel title="تغطية الشموع" note={`${coverage.length} سلسلة`}>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>العملة</th><th>الإطار</th><th>شموع</th><th>من</th><th>إلى</th></tr></thead>
              <tbody>
                {coverage.map((c, i) => (
                  <tr key={i}>
                    <td className="primary"><Num>{c.symbol}</Num></td>
                    <td><Num>{c.timeframe}</Num></td>
                    <td><Num>{int(c.bars)}</Num></td>
                    <td><Num>{dateOnly(c.first)}</Num></td>
                    <td><Num>{dateOnly(c.last)}</Num></td>
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

function archiveStatusAr(status: string): string {
  const map: Record<string, string> = {
    imported: "مستورد", missing: "غير منشور", failed: "فشل", pending: "بانتظار", downloaded: "مُنزَّل",
  };
  return map[status] ?? status;
}
