"use client";

import { ShieldAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Reveal } from "@/components/ui/Reveal";

const POINTS = ["1", "2", "3", "4", "5", "6"] as const;

/**
 * Risk disclosure, given a page of its own and a link in the header.
 * Everything here is stated plainly rather than in the compressed legal
 * register that exists to be skipped.
 */
export function Disclosure() {
  const { t } = useI18n();

  return (
    <section className="px-[var(--gutter)] py-[var(--section-y)]">
      <div className="max-w-2xl">
        <div className="mb-5 inline-flex items-center gap-2 border border-bear/40 bg-bear/10 px-3 py-1.5">
          <ShieldAlert className="h-4 w-4 text-bear" aria-hidden />
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-bear">
            {t("nav.disclosure")}
          </span>
        </div>
        <h1 className="font-display text-display-sm text-ink sm:text-display">
          {t("site.disclosure.title")}
        </h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted">{t("site.disclosure.lede")}</p>
      </div>

      <div className="mt-14 max-w-3xl space-y-px border-t border-rule">
        {POINTS.map((n, i) => (
          <Reveal key={n} delay={i * 60}>
            <div className="border-b border-rule py-7">
              <h2 className="font-display text-xl text-ink">{t(`site.disclosure.${n}.title`)}</h2>
              <p className="mt-2.5 text-sm leading-relaxed text-ink-muted sm:text-base">
                {t(`site.disclosure.${n}.body`)}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
