"use client";

import { EyeOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Reveal } from "@/components/ui/Reveal";

const POINTS = ["1", "2", "3", "4", "5"] as const;

/**
 * What the engine cannot see.
 *
 * Placed at the end of the Method page on purpose: immediately after the
 * argument for trusting the analysis, and before the reader acts on it. A
 * product that lists only its capabilities teaches the reader to assume
 * complete coverage, and that assumption is far more dangerous than any single
 * missing feature.
 */
export function Limits() {
  const { t } = useI18n();

  return (
    <section id="limits" className="border-b border-rule bg-ground-900/40">
      <div className="px-[var(--gutter)] py-[var(--section-y)]">
        <div className="max-w-2xl">
          <p className="eyebrow mb-2 flex items-center gap-2">
            <EyeOff className="h-3.5 w-3.5" aria-hidden />
            {t("site.limits.eyebrow")}
          </p>
          <h2 className="font-display text-display-sm text-ink sm:text-display">
            {t("site.limits.title")}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-muted">{t("site.limits.lede")}</p>
        </div>

        <div className="mt-12 grid gap-px border border-rule bg-rule sm:grid-cols-2">
          {POINTS.map((n, i) => (
            <Reveal key={n} delay={i * 60}>
              <div className="h-full bg-ground-950 p-6">
                <h3 className="font-display text-lg text-ink">{t(`site.limits.${n}.title`)}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">
                  {t(`site.limits.${n}.body`)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
