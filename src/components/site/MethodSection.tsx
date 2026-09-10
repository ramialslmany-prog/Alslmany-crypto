"use client";

import { useI18n } from "@/lib/i18n/provider";
import { Reveal } from "@/components/ui/Reveal";
import { Num } from "@/components/ui/Num";

const STEPS = ["1", "2", "3", "4", "5"] as const;

/**
 * The method, as a numbered editorial list rather than a card grid.
 * Long-form reasoning is the product here, so it is set as prose with a
 * generous measure instead of being cut into equal boxes.
 */
export function MethodSection() {
  const { t } = useI18n();

  return (
    <section id="method" className="border-b border-rule">
      <div className="px-[var(--gutter)] py-[var(--section-y)]">
        <div className="max-w-2xl">
          <p className="eyebrow mb-2">{t("site.method.eyebrow")}</p>
          <h2 className="font-display text-display-sm text-ink sm:text-display">
            {t("site.method.title")}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-ink-muted">{t("site.method.lede")}</p>
        </div>

        <ol className="mt-14 space-y-px border-t border-rule">
          {STEPS.map((n, i) => (
            <Reveal as="li" key={n} delay={i * 70}>
              <div className="grid gap-4 border-b border-rule py-8 sm:grid-cols-[auto_1fr] sm:gap-10">
                <Num size="lg" className="text-amber/70 sm:w-16">
                  {n.padStart(2, "0")}
                </Num>
                <div className="max-w-3xl">
                  <h3 className="font-display text-xl text-ink sm:text-2xl">
                    {t(`site.method.${n}.title`)}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-ink-muted sm:text-base">
                    {t(`site.method.${n}.body`)}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
