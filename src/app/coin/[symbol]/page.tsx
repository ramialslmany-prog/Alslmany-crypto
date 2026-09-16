/**
 * One coin, in depth.
 *
 * The six-timeframe agreement table is the centrepiece: it is where the flow
 * rule becomes visible, and where "why was this rejected" usually has its
 * answer. Computed live from stored candles, using the same analysis code the
 * pipeline runs.
 */
import Link from "next/link";
import { hasDatabase, query } from "@/web/db";
import { recentRecommendations, rejectedAnalyses } from "@/web/queries";
import { Topbar } from "@/web/components/Topbar";
import { NoDatabase } from "@/web/components/NoDatabase";
import { Direction, Num, Panel } from "@/web/components/ui";
import { analyzeTechnical } from "@/core/analysis/technical";
import { analyzeStructureStage } from "@/core/analysis/structure-stage";
import { BIAS_AR } from "@/core/analysis/types";
import { TIMEFRAMES, type Timeframe } from "@/shared/time";
import type { Candle } from "@/core/types";
import { ago, num, price, timestamp } from "@/web/format";
import { SETUP_AR, type SetupKind } from "@/core/pipeline/types";

export const dynamic = "force-dynamic";

function loadCandles(symbol: string, timeframe: Timeframe, limit = 400): Candle[] {
  return query(
    (db) => db.prepare<[string, string, number], Candle>(
      `SELECT open_time AS openTime, close_time AS closeTime, open, high, low, close,
              volume, quote_volume AS quoteVolume, trades,
              taker_buy_base AS takerBuyBase, taker_buy_quote AS takerBuyQuote
       FROM candles WHERE symbol = ? AND timeframe = ?
       ORDER BY open_time DESC LIMIT ?`,
    ).all(symbol, timeframe, limit).reverse(),
    [] as Candle[],
  );
}

export default async function CoinPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: raw } = await params;
  const symbol = decodeURIComponent(raw).toUpperCase();

  // A missing database is not a missing page: it means the worker has not run
  // yet, and the page should say which command fixes that.
  if (!hasDatabase()) {
    return (
      <>
        <Topbar title={symbol} />
        <div className="content"><NoDatabase /></div>
      </>
    );
  }

  const now = Date.now();
  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of TIMEFRAMES) {
    const bars = loadCandles(symbol, tf);
    if (bars.length > 0) candles[tf] = bars;
  }

  const available = Object.keys(candles) as Timeframe[];
  if (available.length === 0) {
    return (
      <>
        <Topbar title={symbol} />
        <div className="content">
          <div className="empty">
            <strong>لا توجد شموع مخزّنة لهذه العملة.</strong>
            ابنِ تاريخها أولاً:{" "}
            <code>npm run backfill -- --symbols {symbol} --timeframes 1h,4h,1d --years 2</code>
          </div>
        </div>
      </>
    );
  }

  // Prefer 4h as the trading timeframe when present — it is the default
  // horizon the rest of the system is tuned around.
  const tradingTimeframe = available.includes("4h") ? "4h" : available[available.length - 1];

  const technical = analyzeTechnical({
    symbol, candles, tradingTimeframe, hasTakerBreakdown: true, now,
  });

  const tradingCandles = candles[tradingTimeframe] ?? [];
  const structure = tradingCandles.length >= 30
    ? analyzeStructureStage(tradingCandles, tradingTimeframe)
    : null;

  const recs = recentRecommendations(200).filter((r) => r.symbol === symbol);
  const rejects = rejectedAnalyses(500).filter((r) => r.symbol === symbol).slice(0, 10);
  const last = tradingCandles[tradingCandles.length - 1];

  return (
    <>
      <Topbar
        title={symbol}
        sub={`${available.length} إطار متاح · إطار التداول ${tradingTimeframe}`}
        right={last ? <span className="sub">آخر إغلاق <Num>{price(last.close)}</Num></span> : undefined}
      />

      <div className="content">
        {/* ── the six-timeframe table ────────────────────────────────────── */}
        <Panel
          title="توافق الأطر الزمنية"
          note="الإطار الأعلى يحدّد الاتجاه المسموح، والأدنى يحدّد التوقيت فقط"
        >
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>الإطار</th><th>الميل</th><th>النتيجة</th><th>القناعة</th><th>الاتجاه</th><th>الزخم</th><th>الحجم</th><th>التقلّب</th><th>شموع</th></tr>
              </thead>
              <tbody>
                {TIMEFRAMES.map((tf) => {
                  const a = technical.timeframes.find((t) => t.timeframe === tf);
                  const missing = technical.missing.find((m) => m.timeframe === tf);
                  if (!a) {
                    return (
                      <tr key={tf}>
                        <td className="primary"><Num>{tf}</Num></td>
                        <td colSpan={8} style={{ color: "var(--text-3)", whiteSpace: "normal" }}>
                          غير متاح — {missing?.reason ?? "لا بيانات"}
                        </td>
                      </tr>
                    );
                  }
                  const isTrading = tf === tradingTimeframe;
                  return (
                    <tr key={tf} style={isTrading ? { background: "var(--surface-2)" } : undefined}>
                      <td className="primary">
                        <Num>{tf}</Num>
                        {isTrading && <span className="chip chip-accent" style={{ marginInlineStart: 6 }}>التداول</span>}
                      </td>
                      <td className={a.bias === "bullish" ? "profit" : a.bias === "bearish" ? "loss" : ""}>
                        {a.bias === "bullish" ? "▲ " : a.bias === "bearish" ? "▼ " : "— "}
                        {BIAS_AR[a.bias]}
                      </td>
                      <td><Num>{a.score > 0 ? "+" : a.score < 0 ? "−" : ""}{num(Math.abs(a.score), 0)}</Num></td>
                      <td><Num>{a.strength}</Num></td>
                      <td><Num>{num(a.layers.trend.score, 0)}</Num></td>
                      <td><Num>{num(a.layers.momentum.score, 0)}</Num></td>
                      <td><Num>{num(a.layers.volume.score, 0)}</Num></td>
                      <td><Num>{num(a.layers.volatility.score, 0)}</Num></td>
                      <td style={{ color: "var(--text-3)" }}><Num>{a.bars}</Num></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={`verdict ${technical.confluence.verdict === "pass" ? "good" : "bad"}`}>
            {technical.confluence.arabic}
          </div>
        </Panel>

        {/* ── the four layers on the trading timeframe ───────────────────── */}
        {technical.timeframes.find((t) => t.timeframe === tradingTimeframe) && (
          <div className="grid-2">
            {(["trend", "momentum", "volume", "volatility"] as const).map((layerId) => {
              const tf = technical.timeframes.find((t) => t.timeframe === tradingTimeframe)!;
              const layer = tf.layers[layerId];
              return (
                <Panel key={layerId} title={layer.label} note={`النتيجة ${num(layer.score, 0)}`}>
                  <div className="factors">
                    {layer.factors.map((f) => (
                      <div key={f.id} className="factor">
                        <span className="fl">{f.label}</span>
                        <span className="fv">
                          {f.display}
                          {f.contribution !== 0 && (
                            <span style={{ marginInlineStart: 8, color: f.contribution > 0 ? "var(--profit)" : "var(--loss)" }}>
                              {f.contribution > 0 ? "+" : "−"}{num(Math.abs(f.contribution), 1)}
                            </span>
                          )}
                        </span>
                        <span className="fn">{f.note}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              );
            })}
          </div>
        )}

        {/* ── discovered levels ──────────────────────────────────────────── */}
        {structure && structure.levels.length > 0 && (
          <Panel title="المستويات المكتشفة" note="مرتّبة بقوّتها — مناطق لا خطوط">
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th>النوع</th><th>المنطقة</th><th>القوّة</th><th>اختبارات</th><th>صمد</th><th>كُسر</th><th>المسافة</th><th>آخر اختبار</th></tr>
                </thead>
                <tbody>
                  {structure.levels.map((z, i) => (
                    <tr key={i}>
                      <td className="primary">{z.kind.includes("support") ? "دعم" : "مقاومة"}</td>
                      <td className="primary"><Num>{price(z.low)} – {price(z.high)}</Num></td>
                      <td><Num>{z.strength}</Num></td>
                      <td><Num>{z.touchCount}</Num></td>
                      <td><Num className="profit">{z.holdCount}</Num></td>
                      <td><Num className="loss">{z.breakCount}</Num></td>
                      <td>
                        <Num className={z.distancePct > 0 ? "" : ""}>
                          {z.distancePct > 0 ? "+" : "−"}{num(Math.abs(z.distancePct))}% · {num(Math.abs(z.distanceAtr), 1)} ATR
                        </Num>
                      </td>
                      <td style={{ color: "var(--text-3)" }}><Num>{z.barsSinceTouch}</Num> شمعة</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="verdict">{structure.structure.arabic}</div>
          </Panel>
        )}

        {/* ── this coin's history ────────────────────────────────────────── */}
        <div className="split">
          <Panel title="توصيات هذه العملة">
            {recs.length === 0 ? (
              <div className="panel-body"><div className="empty">لم تُولَّد أي توصية على {symbol}.</div></div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>الاتجاه</th><th>النمط</th><th>الثقة</th><th>العائد</th><th>الوقت</th></tr></thead>
                  <tbody>
                    {recs.slice(0, 12).map((r) => (
                      <tr key={r.id}>
                        <td><Link href={`/recommendations/${r.id}`}><Direction direction={r.direction} /></Link></td>
                        <td>{SETUP_AR[r.setup as SetupKind] ?? r.setup}</td>
                        <td><Num>{num(r.confidence, 0)}</Num></td>
                        <td><Num>{num(r.riskReward)}R</Num></td>
                        <td style={{ color: "var(--text-3)" }}><Num>{timestamp(r.generatedAt)}</Num></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="آخر مرات الرفض" note="لماذا لم تُنتج توصية">
            {rejects.length === 0 ? (
              <div className="panel-body"><div className="empty">لا رفض مسجّل لهذه العملة.</div></div>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <tbody>
                    {rejects.map((r, i) => (
                      <tr key={i}>
                        <td><span className="chip"><span className="sym">{r.failedNumber}</span></span></td>
                        <td style={{ whiteSpace: "normal", height: "auto", padding: "7px 12px" }}>{r.reason}</td>
                        <td style={{ color: "var(--text-3)" }}>{ago(r.analyzedAt, now)}</td>
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
