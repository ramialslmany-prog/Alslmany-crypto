"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { useAnalysis, useCandles, useIntegrity } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { CandleChart, type ChartLevel } from "./CandleChart";
import { SignalCard } from "@/components/signal/SignalCard";
import { DataBanner } from "@/components/ui/DataBanner";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { Meter } from "@/components/ui/Meter";
import { fmtPctPlain, fmtPrice } from "@/lib/format";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { cn } from "@/lib/utils";

/**
 * The per-asset deep dive.
 *
 * The chart carries the plan's own levels, so entry, invalidation and targets
 * are read against the price action that produced them rather than as a
 * detached list of numbers.
 */
export function AssetView({ symbol }: { symbol: string }) {
  const { t, lang } = useI18n();
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const { data: analysis, isLoading, isError } = useAnalysis(symbol);
  const { data: candles } = useCandles(symbol, timeframe, 200);
  const { data: integrity } = useIntegrity(symbol);

  const rec = analysis?.data.recommendation ?? null;
  const name = rec ? (lang === "ar" ? rec.nameAr : rec.name) : symbol;

  const levels: ChartLevel[] = rec?.plan
    ? [
        { price: rec.plan.reference, label: t("term.entry"), tone: "amber" },
        { price: rec.plan.stop, label: t("term.stop"), tone: "bear" },
        ...rec.plan.targets.map((target, i) => ({
          price: target.price,
          label: `${t("term.target")} ${i + 1}`,
          tone: "bull" as const,
        })),
      ]
    : [];

  return (
    <>
      <DataBanner meta={analysis?.meta} />
      <PageHeader
        title={symbol}
        subtitle={name}
        actions={
          <div className="flex gap-1" role="group" aria-label={t("term.timeframe")}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setTimeframe(tf)}
                aria-pressed={timeframe === tf}
                className={cn(
                  "btn btn-sm font-mono",
                  timeframe === tf && "border-amber/70 bg-amber/10 text-amber-soft",
                )}
              >
                {tf}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-6 p-5 sm:p-7 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <section className="border border-rule p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-display text-lg text-ink">{t("term.chart.title")}</h2>
              {candles && (
                <Num size="sm" className="text-ink-muted">
                  {fmtPrice(candles.data.candles[candles.data.candles.length - 1]?.c ?? 0, true)}
                </Num>
              )}
            </div>
            {candles ? (
              <CandleChart candles={candles.data.candles} levels={levels} />
            ) : (
              <Skeleton className="h-[340px]" />
            )}
          </section>

          {isLoading ? (
            <Skeleton className="h-64" />
          ) : isError || !rec ? (
            <Empty title={t("state.error")} body={t("term.asset.notTracked")} />
          ) : (
            <>
              <TimeframeBreakdown rec={rec} />
              <Scenarios rec={rec} />
              <Levels rec={rec} />
            </>
          )}
        </div>

        <aside className="min-w-0 space-y-6">
          {rec ? <SignalCard rec={rec} /> : <Skeleton className="h-[30rem]" />}

          {/* Price integrity */}
          <section className="border border-rule">
            <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
              <h2 className="font-display text-base text-ink">{t("term.asset.integrity")}</h2>
              {integrity && (
                <Tag tone={integrity.data.trustworthy ? "bull" : "bear"}>
                  {integrity.data.trustworthy ? t("state.live") : t("state.stale")}
                </Tag>
              )}
            </div>
            <div className="space-y-2 p-4">
              {integrity && integrity.data.quotes.length > 0 ? (
                <>
                  {integrity.data.quotes.map((q) => (
                    <div key={q.venue} className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
                        {q.venue}
                      </span>
                      <Num size="xs">{fmtPrice(q.price, true)}</Num>
                    </div>
                  ))}
                  <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-rule-faint pt-2">
                    <span className="eyebrow">{t("term.asset.spread")}</span>
                    <Num size="xs" tone={integrity.data.spreadPct === null ? "none" : -integrity.data.spreadPct}>
                      {integrity.data.spreadPct === null ? "—" : fmtPctPlain(integrity.data.spreadPct, 3)}
                    </Num>
                  </div>
                </>
              ) : (
                <p className="text-xs text-ink-faint">{t("state.empty")}</p>
              )}
              <p className="pt-2 text-xs leading-relaxed text-ink-faint">
                {t("term.asset.integrityNote")}
              </p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function TimeframeBreakdown({ rec }: { rec: NonNullable<ReturnType<typeof useAnalysis>["data"]>["data"]["recommendation"] }) {
  const { t } = useI18n();
  if (!rec) return null;

  return (
    <section className="border border-rule">
      <h2 className="border-b border-rule px-4 py-3 font-display text-base text-ink">
        {t("term.asset.timeframes")}
      </h2>
      <div className="grid gap-px bg-rule sm:grid-cols-2">
        {rec.timeframes.map((tf) => (
          <div key={tf.timeframe} className="bg-ground-950 p-4">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <span className="font-mono text-sm text-ink">{tf.timeframe}</span>
              <Tag tone={tf.trend === "up" ? "bull" : tf.trend === "down" ? "bear" : "neutral"}>
                {t(`structure.${tf.trend === "up" ? "uptrend" : tf.trend === "down" ? "downtrend" : "range"}`)}
              </Tag>
            </div>
            <Meter
              value={(tf.score + 100) / 2}
              ariaLabel={`${tf.timeframe} ${t("term.score")}`}
              tone={tf.score > 0 ? "bull" : tf.score < 0 ? "bear" : "neutral"}
            />
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <Metric label="RSI" value={tf.rsi} />
              <Metric label="ADX" value={tf.adx} />
              <Metric label="ATR%" value={tf.atrPct} suffix="%" />
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value, suffix = "" }: { label: string; value: number | null; suffix?: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd>
        <Num size="xs" className="text-ink-muted">
          {value === null ? "—" : `${value.toFixed(1)}${suffix}`}
        </Num>
      </dd>
    </div>
  );
}

function Scenarios({ rec }: { rec: NonNullable<ReturnType<typeof useAnalysis>["data"]>["data"]["recommendation"] }) {
  const { t } = useI18n();
  if (!rec) return null;

  return (
    <section className="border border-rule">
      <h2 className="border-b border-rule px-4 py-3 font-display text-base text-ink">
        {t("term.asset.scenarios")}
      </h2>
      <ul className="divide-y divide-rule">
        {rec.scenarios.map((s) => (
          <li key={s.kind} className="p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Tag tone={s.kind === "bullish" ? "bull" : s.kind === "bearish" ? "bear" : "neutral"}>
                {t(`dir.${s.kind === "bullish" ? "long" : s.kind === "bearish" ? "short" : "neutral"}`)}
              </Tag>
              <Num size="sm" className="text-ink">{s.probability}%</Num>
            </div>
            <Meter
              value={s.probability}
              ariaLabel={`${t(s.detailKey)} — ${s.probability}%`}
              tone={s.kind === "bullish" ? "bull" : s.kind === "bearish" ? "bear" : "neutral"}
            />
            <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
              {t(s.triggerKey)} — {t(s.detailKey)}
            </p>
            {s.levels.length > 0 && (
              <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {s.levels.map((price) => (
                  <Num key={price} size="xs" className="text-ink-faint">
                    {fmtPrice(price)}
                  </Num>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Levels({ rec }: { rec: NonNullable<ReturnType<typeof useAnalysis>["data"]>["data"]["recommendation"] }) {
  const { t } = useI18n();
  if (!rec || rec.structure.levels.length === 0) return null;

  return (
    <section className="border border-rule">
      <h2 className="border-b border-rule px-4 py-3 font-display text-base text-ink">
        {t("term.asset.levels")}
      </h2>
      <ul className="divide-y divide-rule-faint">
        {/* Price order, highest first — a level list is read as a ladder
            against the current price, not as a ranking. */}
        {[...rec.structure.levels]
          .sort((a, b) => b.price - a.price)
          .map((level) => (
          <li key={level.price} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <Tag tone={level.kind === "support" ? "bull" : "bear"}>
              {level.kind === "support" ? t("term.asset.support") : t("term.asset.resistance")}
            </Tag>
            <span className="font-mono text-2xs text-ink-faint">
              {level.touches} {t("term.asset.touches")}
            </span>
            <div className="w-24">
              <Meter
                value={level.strength}
                ariaLabel={`${level.kind === "support" ? t("term.asset.support") : t("term.asset.resistance")} ${fmtPrice(level.price)}`}
                tone={level.kind === "support" ? "bull" : "bear"}
              />
            </div>
            <Num size="sm">{fmtPrice(level.price)}</Num>
          </li>
        ))}
      </ul>
    </section>
  );
}
