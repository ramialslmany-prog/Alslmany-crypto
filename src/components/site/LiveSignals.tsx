"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useRecommendations } from "@/lib/hooks";
import { SignalCard } from "@/components/signal/SignalCard";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { DataBanner } from "@/components/ui/DataBanner";
import { Reveal } from "@/components/ui/Reveal";

/**
 * The live showcase.
 *
 * Whatever the engine currently ranks highest, unedited. When nothing
 * qualifies the section says so rather than dropping the bar to fill the grid
 * — an empty shelf is a finding, and filling it on demand would make every
 * other card meaningless.
 */
export function LiveSignals({ limit = 3 }: { limit?: number }) {
  const { t } = useI18n();
  const { data, isLoading, isError } = useRecommendations();

  const actionable =
    data?.data.recommendations.filter((r) => r.verdict === "enter" || r.verdict === "accumulate") ??
    [];
  const shown = actionable.slice(0, limit);

  return (
    <section id="signals" className="border-b border-rule">
      <DataBanner meta={data?.meta} />

      <div className="px-[var(--gutter)] py-[var(--section-y)]">
        <div className="mb-9 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-display-sm text-ink">{t("site.live.title")}</h2>
            <p className="mt-2 text-sm text-ink-muted">{t("site.live.subtitle")}</p>
          </div>
          <Link
            href="/dashboard/signals"
            className="inline-flex items-center gap-1.5 text-sm text-amber-soft transition-colors hover:text-amber"
          >
            {t("site.live.all")}
            <ArrowUpRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
          </Link>
        </div>

        {isLoading ? (
          <div className="grid gap-5 lg:grid-cols-3">
            {Array.from({ length: limit }).map((_, i) => (
              <Skeleton key={i} className="h-[26rem]" />
            ))}
          </div>
        ) : isError ? (
          <Empty title={t("state.error")} body={t("action.retry")} />
        ) : shown.length === 0 ? (
          <Empty title={t("site.live.empty")} body={t("site.record.lede")} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            {shown.map((rec, i) => (
              <Reveal key={rec.symbol} delay={i * 90} as="div" className="h-full">
                <SignalCard rec={rec} className="h-full" />
              </Reveal>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
