"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { UNIVERSE } from "@/lib/market/universe";
import { Num } from "@/components/ui/Num";

/**
 * The hero.
 *
 * Deliberately asymmetric — a wide display column with a narrow instrument
 * rail beside it, rather than the centred stack that makes every landing page
 * look like the same landing page. The headline bleeds past the reading
 * measure so it reads as a masthead rather than a paragraph.
 */
export function Hero() {
  const { t, isRTL } = useI18n();
  const Arrow = isRTL ? ArrowLeft : ArrowRight;

  return (
    <section className="relative overflow-hidden border-b border-rule bg-amber-bloom grain">
      {/* Hairline grid, faint enough to read as texture rather than pattern. */}
      <div
        className="pointer-events-none absolute inset-0 bg-rule-grid bg-grid opacity-40"
        aria-hidden
      />

      <div className="relative grid gap-12 px-[var(--gutter)] py-[var(--section-y)] lg:grid-cols-[1.55fr_1fr] lg:gap-16">
        <div className="animate-fade-up">
          <p className="eyebrow mb-6">{t("site.badge")}</p>

          <h1 className="font-display text-display-sm text-ink sm:text-display lg:text-display-lg">
            {t("site.hero.line1")}
            <br />
            <span className="text-amber">{t("site.hero.line2")}</span>
          </h1>

          <p className="mt-7 max-w-xl text-base leading-relaxed text-ink-muted sm:text-lg">
            {t("site.hero.lede")}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/dashboard" className="btn btn-primary gap-2 px-5 py-2.5">
              {t("site.hero.cta")}
              <Arrow className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/method" className="btn px-5 py-2.5">
              {t("site.hero.secondary")}
            </Link>
          </div>

          <p className="mt-5 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
            {t("site.hero.note")}
          </p>
        </div>

        {/* Instrument rail */}
        <dl className="animate-fade-up stack-delay-3 grid grid-cols-2 content-start gap-px self-start border border-rule bg-rule lg:grid-cols-1">
          <Figure value="4" label={t("site.stat.timeframes")} />
          <Figure value={String(UNIVERSE.length)} label={t("site.stat.assets")} />
          <Figure value="3" label={t("site.stat.venues")} />
          <Figure value="247" label={t("site.stat.checks")} />
        </dl>
      </div>
    </section>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-ground-950/70 px-5 py-6">
      <dd>
        <Num size="xl" className="block leading-none text-amber">
          {value}
        </Num>
      </dd>
      <dt className="mt-2 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </dt>
    </div>
  );
}
