"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Num } from "@/components/ui/Num";
import { cn } from "@/lib/utils";
import type { RealisticLoss } from "@/lib/engine/loss-model";

/**
 * What being wrong actually costs.
 *
 * The one number on this site that can honestly be promised. Nobody can tell
 * you a trade will win; the size of a loss is controllable, and this shows the
 * whole of it — the stop distance plus the slippage, tail and fees that a plain
 * stop-loss figure quietly omits.
 *
 * The breakdown is always shown rather than collapsed into a single number,
 * because the point is precisely that the comfortable figure is not the real
 * one.
 */
export function LossPanel({
  loss,
  compact = false,
  className,
}: {
  loss: RealisticLoss;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const understated = loss.understated;

  return (
    <section
      className={cn(
        "border-b border-rule p-4",
        understated ? "bg-bear/[0.08]" : "bg-bull/[0.06]",
        className,
      )}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          {understated ? (
            <ShieldAlert className="h-4 w-4 shrink-0 text-bear" aria-hidden />
          ) : (
            <ShieldCheck className="h-4 w-4 shrink-0 text-bull" aria-hidden />
          )}
          <span className="eyebrow">{t("loss.realistic")}</span>
        </span>
        <span className="text-end">
          <Num size="lg" tone={-1} className="block leading-none">
            −{loss.realisticPct.toFixed(2)}%
          </Num>
          <span className="mt-0.5 block font-mono text-2xs text-ink-faint">
            −{loss.accountPct.toFixed(2)}% {t("loss.ofAccount")}
          </span>
        </span>
      </header>

      {!compact && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-rule-faint pt-2.5 sm:grid-cols-4">
          <Part label={t("loss.planned")} value={loss.plannedPct} emphasis />
          <Part label={t("loss.slippage")} value={loss.slippagePct} />
          <Part label={t("loss.gap")} value={loss.gapPct} />
          <Part label={t("loss.fees")} value={loss.feesPct} />
        </dl>
      )}

      {/* When reality diverges from the plan, name why rather than just flagging it. */}
      {loss.drivers.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-rule-faint pt-2.5">
          {loss.drivers.map((d) => (
            <li key={d} className="text-xs leading-relaxed text-ink-muted">
              · {t(d)}
            </li>
          ))}
        </ul>
      )}

      {understated && (
        <p className="mt-2.5 border-t border-rule-faint pt-2.5 text-xs leading-relaxed text-bear-soft">
          {t("loss.understated", { multiple: loss.severityMultiple.toFixed(1) })}
        </p>
      )}
    </section>
  );
}

function Part({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd>
        <Num size="xs" className={emphasis ? "text-ink" : "text-ink-muted"}>
          {value > 0 ? `${value.toFixed(2)}%` : "—"}
        </Num>
      </dd>
    </div>
  );
}
