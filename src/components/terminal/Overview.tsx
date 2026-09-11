"use client";

import { useI18n } from "@/lib/i18n/provider";
import { useRecommendations, useSentiment, useGlobal } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { SignalCard } from "@/components/signal/SignalCard";
import { DataBanner } from "@/components/ui/DataBanner";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { Meter } from "@/components/ui/Meter";
import { fmtCompact, fmtPctPlain } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The overview.
 *
 * The regime read sits above the picks, not beside them. Everything below it
 * is conditional on it, and a reader who takes a recommendation without the
 * regime has taken half the analysis.
 */
export function Overview() {
  const { t } = useI18n();
  const { data, isLoading, isError } = useRecommendations();
  const { data: sentiment } = useSentiment();
  const { data: global } = useGlobal();

  const market = data?.data.market;
  const top =
    data?.data.recommendations.filter((r) => r.verdict === "enter" || r.verdict === "accumulate").slice(0, 6) ?? [];

  return (
    <>
      <DataBanner meta={data?.meta} />
      <PageHeader title={t("term.overview.title")} subtitle={t("term.overview.subtitle")} />

      <div className="space-y-8 p-5 sm:p-7">
        {/* Regime */}
        {isLoading ? (
          <Skeleton className="h-44" />
        ) : isError || !market ? (
          <Empty title={t("state.error")} />
        ) : (
          <section className="border border-rule">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
              <div className="flex items-center gap-3">
                <h2 className="font-display text-lg text-ink">{t("term.overview.regime")}</h2>
                <Tag
                  tone={market.label === "bull" ? "bull" : market.label === "bear" ? "bear" : "amber"}
                  dot
                >
                  {t(`regime.${market.label}`)}
                </Tag>
              </div>
              <div className="w-full max-w-xs">
                <Meter
                  label={t("term.riskBudget")}
                  value={market.riskBudget * 100}
                  showValue
                  tone={market.riskBudget >= 0.8 ? "bull" : market.riskBudget >= 0.5 ? "amber" : "bear"}
                />
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
              <Cell label={t("term.score")} value={`${market.score > 0 ? "+" : ""}${market.score}`} tone={market.score} />
              <Cell
                label={t("term.breadth")}
                value={market.breadth === null ? "—" : fmtPctPlain(market.breadth, 0)}
                tone={market.breadth === null ? "none" : market.breadth - 50}
              />
              <Cell
                label={t("term.sentiment")}
                value={sentiment ? String(sentiment.data.value) : "—"}
                tone={sentiment ? sentiment.data.value - 50 : "none"}
              />
              <Cell
                label={t("term.dominance")}
                value={global ? fmtPctPlain(global.data.btcDominance, 1) : "—"}
                tone="none"
              />
            </dl>

            <div className="border-t border-rule px-5 py-4">
              <p className="max-w-2xl text-xs leading-relaxed text-ink-faint">
                {t("term.overview.regimeNote")}
              </p>
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {market.leader.evidence.slice(0, 6).map((e, i) => (
                  <li key={`${e.key}-${i}`} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="min-w-0 flex-1 truncate text-ink-muted">{t(e.key)}</span>
                    <Num size="xs" tone={e.weight}>
                      {e.weight > 0 ? "+" : ""}
                      {Math.round(e.weight)}
                    </Num>
                  </li>
                ))}
              </ul>
            </div>

            {global && (
              <dl className="grid grid-cols-2 gap-px border-t border-rule bg-rule">
                <Cell label={t("term.marketcap")} value={fmtCompact(global.data.totalMarketCap)} tone="none" />
                <Cell label={t("term.volume")} value={fmtCompact(global.data.totalVolume24h)} tone="none" />
              </dl>
            )}
          </section>
        )}

        {/* Picks */}
        <section>
          <h2 className="mb-4 font-display text-lg text-ink">{t("term.overview.topPicks")}</h2>
          {isLoading ? (
            <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[26rem]" />
              ))}
            </div>
          ) : top.length === 0 ? (
            <Empty title={t("site.live.empty")} body={t("term.bot.noOpenBody")} />
          ) : (
            <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
              {top.map((rec) => (
                <SignalCard key={rec.symbol} rec={rec} className="h-full" />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: number | "none";
}) {
  return (
    <div className={cn("bg-ground-950 px-5 py-4")}>
      <dt className="eyebrow mb-1.5">{label}</dt>
      <dd>
        <Num size="lg" tone={tone} className="leading-none">
          {value}
        </Num>
      </dd>
    </div>
  );
}
