"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";

export function CallToAction() {
  const { t, isRTL } = useI18n();
  const Arrow = isRTL ? ArrowLeft : ArrowRight;

  return (
    <section className="relative overflow-hidden bg-amber-bloom grain">
      <div className="relative px-[var(--gutter)] py-[var(--section-y)] text-center">
        <h2 className="font-display text-display-sm text-ink sm:text-display">
          {t("site.cta.title")}
        </h2>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-ink-muted">
          {t("site.cta.body")}
        </p>
        <Link href="/dashboard" className="btn btn-primary mt-8 gap-2 px-6 py-3">
          {t("site.cta.button")}
          <Arrow className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
