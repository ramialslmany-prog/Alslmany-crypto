"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/provider";
import { Logo } from "@/components/ui/Logo";

export function SiteFooter() {
  const { t } = useI18n();

  return (
    <footer className="border-t border-rule bg-ground-950">
      <div className="grid gap-8 px-[var(--gutter)] py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2.5 text-amber">
            <Logo />
            <span className="font-display text-base text-ink">{t("brand.name")}</span>
          </div>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-muted">
            {t("brand.tagline")}
          </p>
          <p className="mt-4 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
            {t("site.footer.built")}
          </p>
        </div>

        <div>
          <p className="eyebrow mb-3">{t("site.footer.product")}</p>
          <ul className="space-y-2 text-sm">
            <li><Link href="/dashboard" className="text-ink-muted transition-colors hover:text-ink">{t("nav.terminal")}</Link></li>
            <li><Link href="/method" className="text-ink-muted transition-colors hover:text-ink">{t("nav.method")}</Link></li>
            <li><Link href="/bot" className="text-ink-muted transition-colors hover:text-ink">{t("nav.bot")}</Link></li>
            <li><Link href="/performance" className="text-ink-muted transition-colors hover:text-ink">{t("nav.performance")}</Link></li>
          </ul>
        </div>

        <div>
          <p className="eyebrow mb-3">{t("site.footer.legal")}</p>
          <ul className="space-y-2 text-sm">
            <li><Link href="/disclosure" className="text-ink-muted transition-colors hover:text-ink">{t("nav.disclosure")}</Link></li>
          </ul>
          <p className="mt-4 font-mono text-2xs uppercase tracking-[0.14em] text-ink-faint">
            {t("site.footer.data")}: Binance · OKX · Bybit
          </p>
        </div>
      </div>

      {/* The disclaimer is part of the furniture, not a link someone must find. */}
      <div className="border-t border-rule px-[var(--gutter)] py-5">
        <p className="max-w-4xl text-xs leading-relaxed text-ink-faint">
          {t("disclaimer.long")}
        </p>
      </div>
    </footer>
  );
}
