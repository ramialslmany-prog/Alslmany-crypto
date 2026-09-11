"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useBot } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { EquityCurve } from "@/components/site/EquityCurve";
import { fmtDate, fmtDuration, fmtPct, fmtPrice, fmtR } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Position } from "@/lib/bot/types";

/**
 * The trade journal.
 *
 * Every closed trade, newest first, each expandable to the thesis frozen at
 * entry. Being able to read why a losing trade was taken is the only thing
 * that turns a ledger into something you can learn from.
 */
export function Journal() {
  const { t } = useI18n();
  const { data, isLoading, isError } = useBot();
  const snapshot = data?.data;
  const trades = snapshot?.closed ?? [];

  return (
    <>
      <PageHeader title={t("term.journal.title")} subtitle={t("term.journal.subtitle")} />

      <div className="space-y-7 p-5 sm:p-7">
        {isLoading ? (
          <Skeleton className="h-64" />
        ) : isError ? (
          <Empty title={t("state.error")} />
        ) : trades.length === 0 ? (
          <Empty title={t("term.journal.empty")} body={t("term.bot.noOpenBody")} />
        ) : (
          <>
            {snapshot && snapshot.equityR.length > 1 && (
              <section className="border border-rule p-5">
                <p className="eyebrow mb-4">R · {snapshot.stats.trades}</p>
                <EquityCurve points={snapshot.equityR} />
              </section>
            )}

            {snapshot && (
              <dl className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
                <Cell label={t("term.trades")} value={String(snapshot.stats.trades)} />
                <Cell
                  label={t("term.winrate")}
                  value={`${snapshot.stats.winRate.toFixed(0)}%`}
                  tone={snapshot.stats.winRate - 50}
                />
                <Cell
                  label={t("site.record.expectancy")}
                  value={fmtR(snapshot.stats.expectancyR)}
                  tone={snapshot.stats.expectancyR}
                />
                <Cell
                  label="Max DD"
                  value={`−${snapshot.stats.maxDrawdownR.toFixed(2)}R`}
                  tone={-1}
                />
              </dl>
            )}

            <ul className="space-y-2">
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

function TradeRow({ trade }: { trade: Position }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const won = trade.realizedR > 0.02;
  const flat = Math.abs(trade.realizedR) <= 0.02;

  return (
    <li className="border border-rule bg-ground-900/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 py-3 text-start transition-colors hover:bg-ground-850"
      >
        <span className="flex items-center gap-3">
          <span
            className={cn(
              "inline-block h-2 w-2 shrink-0 rounded-full",
              flat ? "bg-ink-faint" : won ? "bg-bull" : "bg-bear",
            )}
            aria-hidden
          />
          <span className="font-display text-base text-ink">{trade.symbol}</span>
          <Tag tone="muted">{trade.thesis.grade}</Tag>
          <Tag tone={flat ? "neutral" : won ? "bull" : "bear"}>
            {t(`exit.${trade.exitReason ?? "manual"}`)}
          </Tag>
        </span>

        <span className="flex items-center gap-5">
          <span className="hidden text-xs text-ink-faint sm:inline">
            {trade.closedAt ? fmtDate(trade.closedAt) : "—"}
          </span>
          <span className="hidden text-xs text-ink-faint md:inline">
            {trade.closedAt ? fmtDuration(trade.closedAt - trade.openedAt, lang) : "—"}
          </span>
          <Num size="xs" tone={trade.realizedPct}>
            {fmtPct(trade.realizedPct)}
          </Num>
          <Num size="sm" tone={trade.realizedR} className="w-16 text-end">
            {fmtR(trade.realizedR)}
          </Num>
          <ChevronDown
            className={cn("h-4 w-4 text-ink-faint transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div className="grid gap-5 border-t border-rule p-4 sm:grid-cols-2">
          <div>
            <p className="eyebrow mb-2.5">{t("term.journal.thesis")}</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Field label={t("term.entry")} value={fmtPrice(trade.entry)} />
              <Field label={t("term.stop")} value={fmtPrice(trade.initialStop)} />
              <Field label={t("term.score")} value={String(trade.thesis.score)} />
              <Field label={t("term.confidence")} value={`${trade.thesis.confidence}%`} />
              <Field label={t("term.rr")} value={`${trade.thesis.plannedRewardRisk}R`} />
              <Field label={t("term.risk")} value={`${trade.riskPct}%`} />
            </dl>

            {trade.thesis.bullish.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-rule-faint pt-2.5">
                {trade.thesis.bullish.slice(0, 4).map((f, i) => (
                  <li key={`${f.key}-${i}`} className="flex items-baseline gap-2 text-xs">
                    <span className="num shrink-0 text-2xs text-ink-faint">{f.timeframe}</span>
                    <span className="min-w-0 flex-1 text-ink-muted">{t(f.key)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="eyebrow mb-2.5">{t("term.journal.result")}</p>
            <ul className="space-y-1.5">
              {trade.fills
                .filter((f) => f.reason !== "entry")
                .map((fill, i) => (
                  <li key={`${fill.at}-${i}`} className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
                      {t(`exit.${fill.reason === "entry" ? "manual" : fill.reason}`)} ·{" "}
                      {Math.round(fill.fraction * 100)}%
                    </span>
                    <span className="flex items-baseline gap-2">
                      <Num size="xs" className="text-ink-muted">
                        {fmtPrice(fill.price)}
                      </Num>
                      <Num size="xs" tone={fill.rMultiple}>
                        {fmtR(fill.rMultiple)}
                      </Num>
                    </span>
                  </li>
                ))}
            </ul>

            {trade.thesis.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-rule-faint pt-2.5">
                {trade.thesis.warnings.map((w) => (
                  <li key={w} className="text-xs leading-relaxed text-ink-faint">
                    {t(w)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd>
        <Num size="xs" className="text-ink-muted">
          {value}
        </Num>
      </dd>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: number }) {
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
