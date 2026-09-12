"use client";

import { useI18n } from "@/lib/i18n/provider";
import { useBot } from "@/lib/hooks";
import { Num } from "@/components/ui/Num";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { EquityCurve } from "./EquityCurve";
import { fmtPctPlain, fmtR } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The public track record.
 *
 * Reads the ledger and nothing else. Losses, drawdown and the losing streak
 * are given the same prominence as the win rate, because the numbers a record
 * omits are the ones a reader most needs.
 */
export function TrackRecord({ full = false }: { full?: boolean }) {
  const { t } = useI18n();
  const { data, isLoading } = useBot();
  const stats = data?.data.stats;

  return (
    <section id="performance" className="border-b border-rule">
      <div className="px-[var(--gutter)] py-[var(--section-y)]">
        <div className="max-w-2xl">
          <p className="eyebrow mb-2">{t("site.record.eyebrow")}</p>
          <h2 className="font-display text-display-sm text-ink sm:text-display">
            {t("site.record.title")}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-muted">{t("site.record.lede")}</p>
        </div>

        {isLoading ? (
          <div className="mt-12 grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : !stats || stats.trades === 0 ? (
          <Empty className="mt-12" title={t("site.record.empty")} body={t("disclaimer.short")} />
        ) : (
          <>
            <div className="mt-12 grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
              <Cell label={t("term.trades")} value={String(stats.trades)} />
              <Cell
                label={t("term.winrate")}
                value={fmtPctPlain(stats.winRate, 0)}
                tone={stats.winRate - 50}
              />
              <Cell
                label={t("site.record.expectancy")}
                value={fmtR(stats.expectancyR)}
                tone={stats.expectancyR}
                emphasis
              />
              <Cell label="Total" value={fmtR(stats.totalR)} tone={stats.totalR} />

              <Cell label={`${t("term.trades")} +`} value={String(stats.wins)} tone={1} />
              <Cell label={`${t("term.trades")} −`} value={String(stats.losses)} tone={-1} />
              <Cell
                label="Max drawdown"
                value={`−${stats.maxDrawdownR.toFixed(2)}R`}
                tone={-1}
              />
              <Cell
                label="Profit factor"
                value={stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}
                tone={stats.profitFactor === null ? "none" : stats.profitFactor - 1}
              />
            </div>

            <p className="mt-4 max-w-2xl text-xs leading-relaxed text-ink-faint">
              {t("site.record.expectancy.note")}
            </p>

            {data && data.data.equityR.length > 1 && (
              <div className="mt-10 border border-rule p-5">
                <p className="eyebrow mb-4">R · {stats.trades}</p>
                <EquityCurve points={data.data.equityR} />
              </div>
            )}

            {full && (
              <div className="mt-8 grid gap-px border border-rule bg-rule sm:grid-cols-3">
                <Cell label={t("term.open")} value={String(data?.data.open.length ?? 0)} />
                <Cell label="Avg win" value={fmtR(stats.averageWinR)} tone={1} />
                <Cell label="Avg loss" value={fmtR(stats.averageLossR)} tone={-1} />
              </div>
            )}
          </>
        )}

        <div className="mt-10 border-s-2 border-amber/50 bg-amber/10 px-5 py-4">
          <p className="font-display text-base text-amber-soft">
            {t("site.record.disclaimerTitle")}
          </p>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
            {t("site.record.disclaimerBody")}
          </p>
        </div>
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  tone,
  emphasis = false,
}: {
  label: string;
  value: string;
  tone?: number | "none";
  emphasis?: boolean;
}) {
  return (
    <div className={cn("bg-ground-950 px-5 py-6", emphasis && "bg-ground-900")}>
      <p className="eyebrow mb-2">{label}</p>
      <Num size={emphasis ? "xl" : "lg"} tone={tone ?? "none"} className="block leading-none">
        {value}
      </Num>
    </div>
  );
}
