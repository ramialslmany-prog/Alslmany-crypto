/**
 * Settings.
 *
 * READ-ONLY, deliberately. Everything here is configured in `.env.local` and
 * loaded at process start, so the page shows what the bot is actually running
 * with. A form that wrote settings would create a second source of truth that
 * disagrees with the file the operator edited — and would mean the website
 * could change how the bot trades, which it must not be able to do.
 */
import { hasDatabase } from "@/web/db";
import { activeBreakers } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { Num, Panel } from "@/web/components/ui";
import { getConfig } from "@/shared/config";
import { LiveBroker } from "@/core/execution/live-broker";
import { num, timestamp } from "@/web/format";

export const dynamic = "force-dynamic";

export default function Settings() {
  const cfg = getConfig();
  const live = new LiveBroker(cfg);
  const preflight = live.preflight();
  const breakers = hasDatabase() ? activeBreakers() : [];

  const risk: [string, string, string][] = [
    ["مخاطرة كل صفقة", `${num(cfg.RISK_PER_TRADE_PCT, 2)}%`, "من رأس المال — عدد الوحدات يتبع مسافة الوقف"],
    ["أقصى مراكز مفتوحة", String(cfg.MAX_OPEN_POSITIONS), "—"],
    ["أقصى مراكز مترابطة", String(cfg.MAX_CORRELATED_POSITIONS), `فوق ارتباط ${cfg.CORRELATION_THRESHOLD} في نفس الاتجاه`],
    ["قاطع الخسارة اليومية", `${num(cfg.DAILY_LOSS_HALT_PCT, 1)}%`, `يوقف البوت ${cfg.DAILY_HALT_HOURS} ساعة ثم يستأنف تلقائياً`],
    ["قاطع التراجع", `${num(cfg.MAX_DRAWDOWN_HALT_PCT, 1)}%`, "من الذروة — لا يستأنف إلا بتشغيل يدوي"],
    ["رأس المال الافتراضي", num(cfg.PAPER_STARTING_EQUITY, 2), "التنفيذ ورقي بالكامل"],
  ];

  const thresholds: [string, string, string][] = [
    ["أقل نتيجة مقبولة", String(cfg.MIN_FINAL_SCORE), "دونها يُفعَّل فلتر نقض"],
    ["أقل عائد للمخاطرة", num(cfg.MIN_RISK_REWARD, 2), "مرجّح عبر الخروج التدريجي"],
    ["سقف الارتباط بالبيتكوين", num(cfg.MAX_BTC_CORRELATION_FOR_INDEPENDENCE, 2), "فوقه التحليل الفني ليس مستقلاً وتُخفض الثقة"],
    ["أقل عمر إدراج", `${cfg.MIN_LISTING_AGE_DAYS} يوم`, "التاريخ المجهول يُرفض أيضاً"],
  ];

  const providers = [
    cfg.providers.cryptoquant,
    cfg.providers.coinglass,
    cfg.providers.lunarcrush,
    cfg.providers.telegram,
  ];

  return (
    <>
      <Topbar
        title="الإعدادات"
        sub="للقراءة فقط — تُعدَّل في .env.local"
        right={<span className="sub">المنصّة <Num>{cfg.MARKET_EXCHANGE}</Num></span>}
      />

      <div className="content">
        <Panel title="لماذا هذه الصفحة للقراءة فقط">
          <div className="verdict">
            كل ما هنا يُقرأ من <Num>.env.local</Num> عند تشغيل العامل، فالصفحة تعرض ما يعمل به
            البوت فعلاً. نموذج يكتب الإعدادات كان سيُنشئ مصدر حقيقة ثانياً يخالف الملف الذي
            حرّرته، وكان سيعني أن الموقع يستطيع تغيير طريقة تداول البوت — وهذا ما يجب ألّا يقدر عليه.
          </div>
        </Panel>

        <div className="split">
          <Panel title="إدارة المخاطر" note="حدود صارمة لا اقتراحات">
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  {risk.map(([k, v, d]) => (
                    <tr key={k}>
                      <td className="primary">{k}</td>
                      <td><Num>{v}</Num></td>
                      <td style={{ color: "var(--text-3)", whiteSpace: "normal" }}>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="عتبات القرار">
            <div className="table-scroll">
              <table className="table">
                <tbody>
                  {thresholds.map(([k, v, d]) => (
                    <tr key={k}>
                      <td className="primary">{k}</td>
                      <td><Num>{v}</Num></td>
                      <td style={{ color: "var(--text-3)", whiteSpace: "normal" }}>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <Panel title="المصادر الاختيارية" note="تعمل بمجرّد وضع المفتاح">
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>المصدر</th><th>الحالة</th><th>الملاحظة</th></tr></thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td className="primary">{p.label}</td>
                    <td>
                      <span className={`chip ${p.enabled ? "chip-info" : ""}`}>
                        {p.enabled ? "مُفعَّل" : "معطّل"}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px" }}>{p.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="التداول الحقيقي" note="ثلاث بوّابات مستقلة">
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>الشرط</th><th>الحالة</th></tr></thead>
              <tbody>
                {preflight.checks.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className={`chip ${c.passed ? "chip-info" : "chip-short"}`}>
                        {c.passed ? "متحقّق" : "غير متحقّق"}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px" }}>{c.arabic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`verdict ${preflight.ready ? "warn" : "good"}`}>
            {preflight.arabic}
            {" "}
            وحتى عند تحقّق كل الشروط، مسار إرسال الأوامر غير مُنفَّذ عمداً — وصله قبل أن تبرّره
            نتائج التداول الورقي يعني بناء الجزء الوحيد القادر على خسارة المال اعتماداً على منطق
            غير مُختبَر.
          </div>
        </Panel>

        {/* ── the danger zone ───────────────────────────────────────────── */}
        <Panel title="منطقة الخطر">
          {breakers.length > 0 ? (
            <>
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>القاطع</th><th>مُفعَّل منذ</th><th>الاستئناف</th><th>السبب</th></tr></thead>
                  <tbody>
                    {breakers.map((b) => (
                      <tr key={b.kind}>
                        <td className="primary">{b.kind === "daily_loss" ? "خسارة يومية" : b.kind === "max_drawdown" ? "تراجع من الذروة" : "يدوي"}</td>
                        <td><Num>{timestamp(b.trippedAt)}</Num></td>
                        <td>{b.requiresManualReset ? "يدوي فقط" : b.resumesAt ? <Num>{timestamp(b.resumesAt)}</Num> : "—"}</td>
                        <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px" }}>{b.arabic}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="verdict bad">
                إعادة التشغيل تتمّ من سطر الأوامر على الخادم، لا من المتصفّح. قاطع التراجع يعني
                احتمال أن الاستراتيجية نفسها لا تناسب السوق الحالي، وإلغاؤه بنقرة واحدة من صفحة
                ويب يجعل التوقّف بلا معنى.
              </div>
            </>
          ) : (
            <div className="verdict good">
              لا قواطع مفعّلة. البوت يعمل ضمن حدوده.
            </div>
          )}
        </Panel>

        <Panel title="التشغيل">
          <div className="table-scroll">
            <table className="table">
              <tbody>
                <tr><td>قاعدة البيانات</td><td><Num>{cfg.dbPath}</Num></td></tr>
                <tr><td>الأرشيف</td><td><Num>{cfg.archivePath}</Num></td></tr>
                <tr><td>العملة المقابلة</td><td><Num>{cfg.QUOTE_ASSET}</Num></td></tr>
                <tr><td>حدّ العملات</td><td><Num>{cfg.UNIVERSE_MAX_SYMBOLS}</Num></td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}
