"use client";

import Link from "next/link";
import { ArrowUpRight, ShieldAlert, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn, clamp } from "@/lib/utils";
import { fmtPrice, fmtPctPlain } from "@/lib/format";
import { Num } from "@/components/ui/Num";
import { Tag, type TagTone } from "@/components/ui/Tag";
import { Meter } from "@/components/ui/Meter";
import type { Recommendation, Verdict } from "@/lib/engine/recommendation";

/**
 * The signal card — the element this product is designed around.
 *
 * A recommendation rendered as an instrument readout rather than an arrow:
 * the price ladder puts entry, invalidation and every staged target on one
 * scale, so the shape of the risk is visible before any number is read.
 * Reward sits above the entry line and risk below it at true proportion, which
 * means a setup with poor reward-to-risk *looks* wrong at a glance.
 */

const VERDICT_TONE: Record<Verdict, TagTone> = {
  enter: "bull",
  accumulate: "amber",
  watch: "neutral",
  reduce: "bear",
  avoid: "bear",
};

export function SignalCard({
  rec,
  compact = false,
  className,
}: {
  rec: Recommendation;
  compact?: boolean;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const name = lang === "ar" ? rec.nameAr : rec.name;
  const plan = rec.plan;

  return (
    <article
      className={cn(
        "group relative flex flex-col border border-rule bg-ground-900/70 transition-colors duration-300 ease-instrument",
        "hover:border-rule-strong focus-within:border-amber/50",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-4 border-b border-rule p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-xl leading-none text-ink">{rec.symbol}</h3>
            <Tag tone={VERDICT_TONE[rec.verdict]}>{t(`verdict.${rec.verdict}`)}</Tag>
            {rec.grade !== "C" && (
              <Tag tone="muted" className="border-amber/30 text-amber-soft">
                {rec.grade}
              </Tag>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-ink-faint">{name}</p>
        </div>

        <div className="shrink-0 text-end">
          <Num size="lg" className="block leading-none">
            {fmtPrice(rec.price, true)}
          </Num>
          <p className="mt-1 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
            {t(`horizon.${rec.horizon}`)}
          </p>
        </div>
      </header>

      {plan ? (
        <PriceLadder rec={rec} />
      ) : (
        <div className="border-b border-rule px-4 py-8 text-center">
          <p className="font-display text-lg text-ink-muted">{t(`verdict.${rec.verdict}`)}</p>
          <p className="mt-1 text-xs text-ink-faint">{t("term.invalidation")}</p>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 border-b border-rule p-4">
        <Meter label={t("term.score")} value={rec.score} showValue tone="amber" />
        <Meter
          label={t("term.confidence")}
          value={rec.confidence}
          showValue
          tone={rec.confidence >= 65 ? "bull" : rec.confidence >= 45 ? "amber" : "neutral"}
        />
        <div>
          <p className="eyebrow mb-1">{t("term.rr")}</p>
          <Num size="sm" tone={plan ? plan.rewardRisk - 1.8 : "none"} className="leading-none">
            {plan ? `${plan.rewardRisk.toFixed(2)}R` : "—"}
          </Num>
        </div>
      </div>

      {!compact && <Evidence rec={rec} />}

      {/* Warnings sit above the call to action, never beneath it. */}
      {rec.warnings.length > 0 && (
        <ul className="space-y-1.5 border-b border-rule bg-bear-wash/40 p-4">
          {rec.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bear" aria-hidden />
              <span>{t(w)}</span>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-auto flex items-center justify-between gap-3 p-3">
        <span className="font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
          {rec.dataSource}
        </span>
        <Link
          href={`/dashboard/asset/${rec.symbol}`}
          className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-[0.14em] text-amber-soft transition-colors hover:text-amber"
        >
          {t("action.details")}
          <ArrowUpRight className="h-3 w-3 rtl:-scale-x-100" aria-hidden />
        </Link>
      </footer>
    </article>
  );
}

/**
 * The price ladder.
 *
 * Everything is positioned on one linear scale running from the stop to the
 * highest target, so the distance between entry and invalidation is drawn at
 * the same proportion as the distance to reward. The geometry carries the
 * information before a single label is read.
 */
function PriceLadder({ rec }: { rec: Recommendation }) {
  const { t } = useI18n();
  const plan = rec.plan;
  if (!plan) return null;

  const top = Math.max(...plan.targets.map((x) => x.price), plan.reference);
  const bottom = plan.stop;
  const span = top - bottom || 1;
  const pos = (price: number) => clamp(((price - bottom) / span) * 100, 0, 100);
  const entryPos = pos(plan.reference);

  return (
    <div className="border-b border-rule p-4">
      <div className="flex gap-4">
        <div className="relative w-1.5 shrink-0 rounded-sm bg-ground-800" aria-hidden>
          <div
            className="absolute inset-x-0 top-0 rounded-sm bg-bull/35"
            style={{ bottom: `${entryPos}%` }}
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-sm bg-bear/35"
            style={{ height: `${entryPos}%` }}
          />
          {plan.targets.map((target) => (
            <div
              key={target.price}
              className="absolute inset-x-[-2px] h-px bg-bull/70"
              style={{ bottom: `${pos(target.price)}%` }}
            />
          ))}
          <div className="absolute inset-x-[-3px] h-px bg-amber" style={{ bottom: `${entryPos}%` }} />
        </div>

        <dl className="min-w-0 flex-1 space-y-2">
          {[...plan.targets].reverse().map((target, i) => (
            <Rung
              key={target.price}
              label={`${t("term.target")} ${plan.targets.length - i}`}
              price={target.price}
              tone="bull"
              meta={`${target.rMultiple}R · ${target.allocationPct}%`}
              icon={<Target className="h-3 w-3" aria-hidden />}
            />
          ))}

          <Rung
            label={t("term.entry")}
            price={plan.reference}
            tone="amber"
            meta={`${fmtPrice(plan.entryLow)} – ${fmtPrice(plan.entryHigh)}`}
            emphasis
          />

          <Rung
            label={t("term.stop")}
            price={plan.stop}
            tone="bear"
            meta={`−${fmtPctPlain(plan.stopDistancePct)} · 1R`}
          />
        </dl>
      </div>

      <p className="mt-3 border-t border-rule-faint pt-2.5 text-xs leading-relaxed text-ink-faint">
        {t(plan.invalidationKey)} · <Num size="xs">{fmtPrice(plan.invalidationPrice)}</Num>
      </p>
    </div>
  );
}

function Rung({
  label,
  price,
  tone,
  meta,
  icon,
  emphasis = false,
}: {
  label: string;
  price: number;
  tone: "bull" | "bear" | "amber";
  meta?: string;
  icon?: React.ReactNode;
  emphasis?: boolean;
}) {
  const colour = { bull: "text-bull", bear: "text-bear", amber: "text-amber-soft" }[tone];
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={cn(
          "flex shrink-0 items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.12em]",
          colour,
        )}
      >
        {icon}
        {label}
      </dt>
      <dd className="flex min-w-0 items-baseline gap-2">
        {meta && <span className="truncate font-mono text-2xs text-ink-faint">{meta}</span>}
        <Num size={emphasis ? "sm" : "xs"} className={cn(emphasis && "text-ink")}>
          {fmtPrice(price)}
        </Num>
      </dd>
    </div>
  );
}

/**
 * The audit trail.
 *
 * Both columns always render, even when one side is overwhelming. A card that
 * hid its counter-evidence whenever the verdict was positive would be
 * marketing wearing the costume of analysis.
 */
function Evidence({ rec }: { rec: Recommendation }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-1 gap-px border-b border-rule bg-rule sm:grid-cols-2">
      <FactorColumn title={t("dir.long")} tone="bull" factors={rec.bullish.slice(0, 4)} />
      <FactorColumn title={t("dir.short")} tone="bear" factors={rec.bearish.slice(0, 4)} />
    </div>
  );
}

function FactorColumn({
  title,
  tone,
  factors,
}: {
  title: string;
  tone: "bull" | "bear";
  factors: Recommendation["bullish"];
}) {
  const { t } = useI18n();
  return (
    <div className="bg-ground-900 p-4">
      <p className={cn("eyebrow mb-2", tone === "bull" ? "text-bull/70" : "text-bear/70")}>
        {title}
      </p>
      {factors.length === 0 ? (
        <p className="text-xs text-ink-faint">{t("state.empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {factors.map((f, i) => (
            <li key={`${f.key}-${f.timeframe}-${i}`} className="flex items-baseline gap-2">
              <span className="num shrink-0 text-2xs text-ink-faint">{f.timeframe}</span>
              <span className="min-w-0 flex-1 text-xs leading-snug text-ink-muted">{t(f.key)}</span>
              <span
                className={cn(
                  "num shrink-0 text-2xs",
                  tone === "bull" ? "text-bull/80" : "text-bear/80",
                )}
              >
                {f.weight > 0 ? "+" : ""}
                {f.weight}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
