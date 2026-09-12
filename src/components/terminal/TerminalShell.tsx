"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity, BarChart3, Bot, Calculator, Gauge, History, LayoutGrid,
  Menu, Settings, Signal, X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Logo } from "@/components/ui/Logo";
import { LangToggle } from "@/components/ui/LangToggle";
import { cn } from "@/lib/utils";

type Item = { href: string; key: string; icon: typeof Gauge };

const GROUPS: { key: string; items: Item[] }[] = [
  {
    key: "term.nav.groupAnalysis",
    items: [
      { href: "/dashboard", key: "term.nav.overview", icon: Gauge },
      { href: "/dashboard/signals", key: "term.nav.signals", icon: Signal },
      { href: "/dashboard/markets", key: "term.nav.markets", icon: LayoutGrid },
    ],
  },
  {
    key: "term.nav.groupBot",
    items: [
      { href: "/dashboard/bot", key: "term.nav.bot", icon: Bot },
      { href: "/dashboard/journal", key: "term.nav.journal", icon: History },
      { href: "/dashboard/backtest", key: "term.nav.backtest", icon: BarChart3 },
    ],
  },
  {
    key: "term.nav.groupTools",
    items: [
      { href: "/dashboard/calculator", key: "term.nav.calculator", icon: Calculator },
      { href: "/dashboard/settings", key: "term.nav.settings", icon: Settings },
    ],
  },
];

/**
 * The terminal shell.
 *
 * A persistent rail on desktop and a drawer on mobile, driven by one nav
 * definition so the two can never drift apart — a mobile menu that reaches
 * fewer places than the sidebar is the usual outcome of maintaining both.
 */
export function TerminalShell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-e border-rule bg-ground-950 lg:flex">
        <Brand />
        <Nav pathname={pathname} onNavigate={() => undefined} />
        <Footer />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile bar */}
        <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-rule bg-ground-950/90 px-4 py-2.5 backdrop-blur-md lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2 text-amber">
            <Logo className="h-4 w-4" />
            <span className="font-display text-sm text-ink">{t("brand.name")}</span>
          </Link>
          <div className="flex items-center gap-2">
            <LangToggle />
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn btn-sm"
              aria-label={t("action.open")}
              aria-expanded={open}
            >
              <Menu className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ground-950/80 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-label={t("action.close")}
          />
          <div className="absolute inset-y-0 end-0 flex w-64 flex-col border-s border-rule bg-ground-950 shadow-elev-2">
            <div className="flex items-center justify-between border-b border-rule px-4 py-3">
              <span className="font-display text-sm text-ink">{t("brand.name")}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn btn-sm"
                aria-label={t("action.close")}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <Nav pathname={pathname} onNavigate={() => setOpen(false)} />
            <Footer />
          </div>
        </div>
      )}
    </div>
  );
}

function Brand() {
  const { t } = useI18n();
  return (
    <div className="border-b border-rule px-4 py-4">
      <Link href="/dashboard" className="flex items-center gap-2.5 text-amber">
        <Logo />
        <span className="font-display text-base leading-none text-ink">{t("brand.name")}</span>
      </Link>
    </div>
  );
}

function Nav({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { t } = useI18n();

  return (
    <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label={t("term.nav.overview")}>
      {GROUPS.map((group) => (
        <div key={group.key} className="mb-5">
          <p className="eyebrow px-2 pb-2">{t(group.key)}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              // Exact match for the index, prefix match for everything else,
              // so /dashboard does not stay lit on every child route.
              const active =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-sm px-2 py-2 text-sm transition-colors duration-200",
                      active
                        ? "bg-amber/10 text-amber-soft"
                        : "text-ink-muted hover:bg-ground-850 hover:text-ink",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {t(item.key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <div className="border-t border-rule px-4 py-3">
      <Link
        href="/"
        className="flex items-center gap-2 text-xs text-ink-faint transition-colors hover:text-ink-muted"
      >
        <Activity className="h-3.5 w-3.5" aria-hidden />
        {t("term.nav.site")}
      </Link>
      <p className="mt-2 text-2xs leading-relaxed text-ink-faint">{t("disclaimer.short")}</p>
      <div className="mt-2 hidden lg:block">
        <LangToggle />
      </div>
    </div>
  );
}
