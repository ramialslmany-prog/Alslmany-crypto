"use client";

import { AlertTriangle, Database, HardDrive } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useBot } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { Meter } from "@/components/ui/Meter";
import { fmtAgo, fmtDuration, fmtPrice, fmtR } from "@/lib/format";
import { clamp, cn } from "@/lib/utils";
import type { Position } from "@/lib/bot/types";

/**
 * The bot's live book.
 *
 * Unrealised result is shown in R against the *initial* stop, which is the
 * only anchor that stays honest once the stop has moved to breakeven — quoting
 * it against the current stop would make every protected trade look risk-free.
 */
export function BotDesk() {
  const { t } = useI18n();
  const { data, isLoading, isError } = useBot();
  const snapshot = data?.data;

  return (
    <>
      <PageHeader
        title={t("term.bot.title")}
        subtitle={t("term.bot.subtitle")}
        actions={
          snapshot && (
            <Tag tone={snapshot.durable ? "neutral" : "amber"}>
              {snapshot.durable ? (
                <Database className="h-3 w-3" aria-hidden />
              ) : (
                <HardDrive className="h-3 w-3" aria-hidden />
              )}
              {snapshot.durable ? t("term.bot.durable") : t("term.bot.ephemeral")}
            </Tag>
          )
        }
      />

      <div className="space-y-7 p-5 sm:p-7">
        {/* A ledger that silently resets must never look like a strategy that reset. */}
        {snapshot && !snapshot.durable && (
          <div className="flex items-start gap-3 border border-amber/30 bg-amber-wash px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
            <p className="text-xs leading-relaxed text-ink-muted">
              {t("term.bot.ephemeralNote")}
            </p>
          </div>
        )}

        <section>
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg text-ink">{t("term.bot.open")}</h2>
            {snapshot && (
              <span className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
                {snapshot.open.length} / {snapshot.config.maxPositions}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : isError ? (
            <Empty title={t("state.error")} />
          ) : !snapshot || snapshot.open.length === 0 ? (
            <Empty title={t("term.bot.noOpen")} body={t("term.bot.noOpenBody")} />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {snapshot.open.map((position) => (
                <PositionCard key={position.id} position={position} />
              ))}
            </div>
          )}
        </section>

        {snapshot && snapshot.events.length > 0 && (
          <section className="border border-rule">
            <h2 className="border-b border-rule px-4 py-3 font-display text-base text-ink">
              {t("term.bot.events")}
            </h2>
            <ul className="divide-y divide-rule-faint">
              {snapshot.events.slice(0, 12).map((event, i) => (
                <li
                  key={`${event.positionId}-${event.at}-${i}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-sm text-ink">{event.symbol}</span>
                    <span className="text-xs text-ink-muted">{event.detail}</span>
                  </span>
                  <span className="flex items-baseline gap-3">
                    {event.rMultiple !== undefined && (
                      <Num size="xs" tone={event.rMultiple}>
                        {fmtR(event.rMultiple)}
                      </Num>
                    )}
                    <Num size="xs" className="text-ink-faint">
                      {fmtPrice(event.price)}
                    </Num>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {snapshot && (
          <section className="border border-rule">
            <h2 className="border-b border-rule px-4 py-3 font-display text-base text-ink">
              {t("term.bot.config")}
            </h2>
            <dl className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
              <Spec label={t("term.risk")} value={`${snapshot.config.riskPerTradePct}%`} />
              <Spec label={t("term.position")} value={String(snapshot.config.maxPositions)} />
              <Spec label={t("term.rr")} value={`≥ ${snapshot.config.minRewardRisk}`} />
              <Spec label={t("term.confidence")} value={`≥ ${snapshot.config.minConfidence}`} />
            </dl>
          </section>
        )}
      </div>
    </>
  );
}

function PositionCard({ position }: { position: Position }) {
  const { t, lang } = useI18n();

  const risk = position.entry - position.initialStop;
  const unrealisedR = risk > 0 ? (position.lastPrice - position.entry) / risk : 0;
  const totalR = position.realizedR + unrealisedR * position.remaining;

  const top = Math.max(...position.targets.map((x) => x.price), position.entry);
  const progress = clamp(
    ((position.lastPrice - position.initialStop) / (top - position.initialStop)) * 100,
    0,
    100,
  );

  const protectedStop = position.stop >= position.entry;

  return (
    <article className="border border-rule bg-ground-900/60">
      <header className="flex items-start justify-between gap-3 border-b border-rule p-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-lg leading-none text-ink">{position.symbol}</h3>
            <Tag tone="muted">{position.thesis.grade}</Tag>
            {protectedStop && <Tag tone="bull">{t("exit.breakeven")}</Tag>}
          </div>
          <p className="mt-1 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
            {t(`horizon.${position.thesis.horizon}`)} ·{" "}
            {fmtDuration(Date.now() - position.openedAt, lang)}
          </p>
        </div>
        <div className="text-end">
          <Num size="lg" tone={totalR} className="block leading-none">
            {fmtR(totalR)}
          </Num>
          <p className="mt-1 font-mono text-2xs uppercase tracking-[0.12em] text-ink-faint">
            {t("term.bot.unrealized")}
          </p>
        </div>
      </header>

      <div className="space-y-3 p-4">
        <Meter
          label={t("term.bot.progress")}
          value={progress}
          tone={totalR >= 0 ? "bull" : "bear"}
        />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Field label={t("term.entry")} value={fmtPrice(position.entry)} />
          <Field
            label={t("term.stop")}
            value={fmtPrice(position.stop)}
            tone={protectedStop ? 1 : -1}
          />
          <Field label={t("term.price")} value={fmtPrice(position.lastPrice)} />
          <Field
            label={t("term.position")}
            value={`${Math.round(position.remaining * 100)}%`}
          />
        </dl>

        <ul className="space-y-1 border-t border-rule-faint pt-2.5">
          {position.targets.map((target, i) => {
            const hit = i < position.targetsHit;
            return (
              <li key={target.price} className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    "font-mono text-2xs uppercase tracking-[0.12em]",
                    hit ? "text-bull" : "text-ink-faint",
                  )}
                >
                  {hit ? "✓" : "·"} {t("term.target")} {i + 1}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="num text-2xs text-ink-faint">
                    {target.rMultiple}R · {target.allocationPct}%
                  </span>
                  <Num size="xs" className={hit ? "text-bull" : undefined}>
                    {fmtPrice(target.price)}
                  </Num>
                </span>
              </li>
            );
          })}
        </ul>

        <p className="border-t border-rule-faint pt-2.5 text-2xs text-ink-faint">
          {t("state.updated")} {fmtAgo(position.lastCheckedAt, lang)}
        </p>
      </div>
    </article>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd>
        <Num size="sm" tone={tone ?? "none"}>
          {value}
        </Num>
      </dd>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ground-950 px-4 py-3">
      <dt className="eyebrow mb-1">{label}</dt>
      <dd>
        <Num size="sm">{value}</Num>
      </dd>
    </div>
  );
}
