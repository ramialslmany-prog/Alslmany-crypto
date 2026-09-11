"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { useRecommendations } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { SignalCard } from "@/components/signal/SignalCard";
import { DataBanner } from "@/components/ui/DataBanner";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { cn } from "@/lib/utils";
import type { Verdict } from "@/lib/engine/recommendation";

type Filter = "all" | "actionable" | "watch" | "avoid";

const MATCHES: Record<Filter, (v: Verdict) => boolean> = {
  all: () => true,
  actionable: (v) => v === "enter" || v === "accumulate",
  watch: (v) => v === "watch",
  avoid: (v) => v === "avoid" || v === "reduce",
};

/**
 * Every recommendation, filterable.
 *
 * The avoided names are kept reachable rather than hidden. Knowing the engine
 * looked at something and rejected it is information — and a list that only
 * ever shows opportunities trains the reader to expect one.
 */
export function SignalsView() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("actionable");
  const { data, isLoading, isError } = useRecommendations();

  const all = data?.data.recommendations ?? [];
  const shown = all.filter((r) => MATCHES[filter](r.verdict));

  const filters: Filter[] = ["actionable", "watch", "avoid", "all"];

  return (
    <>
      <DataBanner meta={data?.meta} />
      <PageHeader
        title={t("term.signals.title")}
        subtitle={t("term.signals.subtitle")}
        actions={
          <div className="flex flex-wrap gap-1.5" role="group">
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  "btn btn-sm",
                  filter === f && "border-amber/70 bg-amber-wash text-amber-soft",
                )}
              >
                {t(`term.signals.filter.${f}`)}
              </button>
            ))}
          </div>
        }
      />

      <div className="p-5 sm:p-7">
        {isLoading ? (
          <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[26rem]" />
            ))}
          </div>
        ) : isError ? (
          <Empty title={t("state.error")} />
        ) : shown.length === 0 ? (
          <Empty title={t("state.empty")} body={t("site.live.empty")} />
        ) : (
          <>
            <p className="mb-4 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
              {t("term.signals.count", { count: shown.length })}
              {data && data.data.skipped.length > 0 && (
                <> · {t("term.signals.skipped", { count: data.data.skipped.length })}</>
              )}
            </p>
            <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
              {shown.map((rec) => (
                <SignalCard key={rec.symbol} rec={rec} className="h-full" />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
