"use client";

import { useState } from "react";
import { Info, Play } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useBacktest } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { DataBanner } from "@/components/ui/DataBanner";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { EquityCurve } from "@/components/site/EquityCurve";
import { fmtDate, fmtPctPlain, fmtR } from "@/lib/format";
import { scanUniverse } from "@/lib/market/universe";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { cn } from "@/lib/utils";

/**
 * The backtester.
 *
 * Its method is stated beside its results, as a caveat rather than a boast.
 * Buy-and-hold is shown alongside the strategy, because a strategy that
 * underperforms simply holding the asset has not earned its complexity.
 */
export function BacktestView() {
  const { t } = useI18n();
  const [symbol, setSymbol] = useState("BTC");
  const [timeframe, setTimeframe] = useState<Timeframe>("4h");
  const [armed, setArmed] = useState(false);

  const { data, isLoading, isError, error } = useBacktest(symbol, timeframe, armed);
  const run = data?.data;
  const universe = scanUniverse(2);

  return (
    <>
      <DataBanner meta={data?.meta} />
      <PageHeader
        title={t("term.backtest.title")}
        subtitle={t("term.backtest.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="bt-symbol">
              {t("term.symbol")}
            </label>
            <select
              id="bt-symbol"
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value);
                setArmed(false);
              }}
              className="rounded-md border border-rule-strong bg-ground-900 px-2.5 py-1.5 font-mono text-sm text-ink focus:border-amber focus:outline-none"
            >
              {universe.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol}
                </option>
              ))}
            </select>

            <div className="flex gap-1" role="group" aria-label={t("term.timeframe")}>
              {TIMEFRAMES.filter((tf) => tf !== "15m").map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => {
                    setTimeframe(tf);
                    setArmed(false);
                  }}
                  aria-pressed={timeframe === tf}
                  className={cn(
                    "btn btn-sm font-mono",
                    timeframe === tf && "border-amber/70 bg-amber-wash text-amber-soft",
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setArmed(true)}
              disabled={isLoading && armed}
              className="btn btn-sm btn-primary gap-1.5"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {isLoading && armed ? t("term.backtest.running") : t("term.backtest.run")}
            </button>
          </div>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* The method is stated before any result, not after it. */}
        <div className="flex items-start gap-3 border border-rule px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <p className="text-xs leading-relaxed text-ink-muted">{t("term.backtest.method")}</p>
        </div>

        {!armed ? (
          <Empty title={t("term.backtest.run")} body={t("term.backtest.subtitle")} />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </div>
        ) : isError ? (
          <Empty
            title={t("state.error")}
            body={error instanceof Error ? error.message : undefined}
          />
        ) : !run ? (
          <Empty title={t("state.empty")} />
        ) : (
          <>
            {run.marketProxy && (
              <div className="flex items-start gap-3 border border-amber/30 bg-amber-wash px-4 py-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
                <p className="text-xs leading-relaxed text-ink-muted">{t("term.backtest.proxy")}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-display text-lg text-ink">
                {run.symbol} · {run.timeframe}
              </h2>
              <Tag tone="muted">
                {run.barsTested} {t("term.backtest.bars")}
              </Tag>
              <span className="font-mono text-2xs text-ink-faint">
                {fmtDate(run.from)} → {fmtDate(run.to)}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
              <Cell label={t("term.trades")} value={String(run.stats.trades)} />
              <Cell
                label={t("term.winrate")}
                value={fmtPctPlain(run.stats.winRate, 0)}
                tone={run.stats.winRate - 50}
              />
              <Cell
                label={t("site.record.expectancy")}
                value={fmtR(run.stats.expectancyR)}
                tone={run.stats.expectancyR}
              />
              <Cell label="Total" value={fmtR(run.stats.totalR)} tone={run.stats.totalR} />

              <Cell label={`${t("term.trades")} +`} value={String(run.stats.wins)} tone={1} />
              <Cell label={`${t("term.trades")} −`} value={String(run.stats.losses)} tone={-1} />
              <Cell
                label="Max DD"
                value={`−${run.stats.maxDrawdownR.toFixed(2)}R`}
                tone={-1}
              />
              <Cell
                label="Profit factor"
                value={run.stats.profitFactor === null ? "—" : run.stats.profitFactor.toFixed(2)}
                tone={run.stats.profitFactor === null ? "none" : run.stats.profitFactor - 1}
              />
            </dl>

            {/* Beating the benchmark is the bar, not producing a positive number. */}
            <div className="grid gap-px border border-rule bg-rule sm:grid-cols-2">
              <Cell
                label={t("term.backtest.buyHold")}
                value={fmtPctPlain(run.buyHoldPct, 1)}
                tone={run.buyHoldPct}
              />
              <Cell
                label={t("term.backtest.strategy")}
                value={fmtR(run.stats.totalR)}
                tone={run.stats.totalR}
              />
            </div>

            {run.equityR.length > 1 && (
              <section className="border border-rule p-5">
                <p className="eyebrow mb-4">R · {run.stats.trades}</p>
                <EquityCurve points={run.equityR} />
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: number | "none" }) {
  return (
    <div className="bg-ground-950 px-5 py-4">
      <dt className="eyebrow mb-1.5">{label}</dt>
      <dd>
        <Num size="lg" tone={tone ?? "none"} className="leading-none">
          {value}
        </Num>
      </dd>
    </div>
  );
}
