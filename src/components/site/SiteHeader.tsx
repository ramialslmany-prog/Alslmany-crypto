"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, Terminal, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Logo } from "@/components/ui/Logo";
import { LangToggle } from "@/components/ui/LangToggle";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/method", key: "nav.method" },
  { href: "/bot", key: "nav.bot" },
  { href: "/performance", key: "nav.performance" },
  { href: "/disclosure", key: "nav.disclosure" },
] as const;

export function SiteHeader() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ground-950/85 backdrop-blur-md">
      <div className="flex items-center justify-between gap-4 px-[var(--gutter)] py-3">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-amber transition-opacity hover:opacity-80"
        >
          <Logo />
          <span className="font-display text-base leading-none text-ink">{t("brand.name")}</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex" aria-label={t("nav.home")}>
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-ink-muted transition-colors hover:text-ink"
            >
              {t(link.key)}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <LangToggle className="hidden sm:inline-flex" />
          <Link href="/dashboard" className="btn btn-sm btn-primary gap-1.5">
            <Terminal className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("nav.terminal")}</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="btn btn-sm md:hidden"
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? t("action.close") : t("action.open")}
          >
            {open ? <X className="h-4 w-4" aria-hidden /> : <Menu className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </div>

      <div
        id="site-menu"
        hidden={!open}
        className={cn("border-t border-rule bg-ground-900 md:hidden")}
      >
        <nav className="flex flex-col px-[var(--gutter)] py-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="border-b border-rule-faint py-3 text-sm text-ink-muted last:border-0"
            >
              {t(link.key)}
            </Link>
          ))}
          <div className="py-3">
            <LangToggle />
          </div>
        </nav>
      </div>
    </header>
  );
}
