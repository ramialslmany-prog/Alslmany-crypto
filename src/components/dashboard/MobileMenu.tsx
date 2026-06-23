"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Menu, X, Activity, LayoutDashboard, Compass, Radar, Wallet,
  Bot, Brain, Layers, Waves, Fish, History, Grid3x3, Newspaper, Settings,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const groups: { key: string; items: { icon: React.ElementType; key: string; href: string }[] }[] = [
  {
    key: "nav.trade",
    items: [
      { icon: LayoutDashboard, key: "nav.overview", href: "/dashboard" },
      { icon: Compass, key: "nav.markets", href: "/dashboard/markets" },
      { icon: Radar, key: "nav.tracker", href: "/dashboard/tracker" },
      { icon: Wallet, key: "nav.portfolio", href: "/dashboard/portfolio" },
    ],
  },
  {
    key: "nav.intelligence",
    items: [
      { icon: Bot, key: "nav.aiTrader", href: "/dashboard/ai-trader" },
      { icon: Brain, key: "nav.aiSignals", href: "/dashboard/ai" },
      { icon: Layers, key: "nav.manualSignals", href: "/dashboard/signals" },
    ],
  },
  {
    key: "nav.analytics",
    items: [
      { icon: Waves, key: "nav.smartMoney", href: "/dashboard/smart-money" },
      { icon: Fish, key: "nav.whaleFlow", href: "/dashboard/whales" },
      { icon: History, key: "nav.backtest", href: "/dashboard/backtest" },
      { icon: Grid3x3, key: "nav.heatmap", href: "/dashboard/heatmap" },
      { icon: Newspaper, key: "nav.news", href: "/dashboard/news" },
    ],
  },
];

/** Full navigation drawer for phones/tablets — reaches EVERY section (the bottom
 *  tab bar only carries the 5 most-used). Trigger lives in the Topbar. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const { t, dir } = useI18n();
  const off = dir === "rtl" ? "100%" : "-100%";

  useEffect(() => setMounted(true), []);

  // Lock body scroll while open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t("nav.menu")}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-ink-muted transition-colors hover:text-ink lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {mounted && createPortal(
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[60] lg:hidden">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/65 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <motion.aside
              initial={{ x: off }} animate={{ x: 0 }} exit={{ x: off }}
              transition={{ type: "tween", duration: 0.22 }}
              className="absolute inset-y-0 start-0 flex w-72 max-w-[84vw] flex-col overflow-y-auto border-e border-white/[0.08] bg-base-900 pb-[env(safe-area-inset-bottom)]"
            >
              <div className="flex items-center justify-between px-5 py-4">
                <span className="flex items-center gap-2.5">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-violet shadow-glow-violet">
                    <Activity className="h-5 w-5 text-base-950" strokeWidth={2.5} />
                  </span>
                  <span className="font-display text-base font-bold tracking-tight">Alslmany<span className="text-cyan"> Crypto</span></span>
                </span>
                <button onClick={() => setOpen(false)} aria-label={t("nav.close")} className="grid h-9 w-9 place-items-center rounded-lg text-ink-muted hover:bg-white/[0.05] hover:text-ink">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <nav className="flex-1 space-y-6 px-3 py-2">
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">{t(g.key)}</div>
                    <div className="mt-2 space-y-0.5">
                      {g.items.map((it) => {
                        const active = pathname === it.href;
                        return (
                          <Link
                            key={it.key} href={it.href} onClick={() => setOpen(false)}
                            className={cn("relative flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors",
                              active ? "bg-white/[0.06] text-ink" : "text-ink-muted hover:bg-white/[0.03] hover:text-ink")}
                          >
                            {active && <span className="absolute start-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-e-full bg-cyan-violet" />}
                            <it.icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-cyan")} strokeWidth={1.85} />
                            {t(it.key)}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>

              <Link
                href="/dashboard/settings" onClick={() => setOpen(false)}
                className={cn("mx-3 mb-4 flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors",
                  pathname === "/dashboard/settings" ? "bg-white/[0.06] text-ink" : "text-ink-muted hover:text-ink")}
              >
                <Settings className={cn("h-[18px] w-[18px]", pathname === "/dashboard/settings" && "text-cyan")} strokeWidth={1.85} /> {t("nav.settings")}
              </Link>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>,
      document.body
      )}
    </>
  );
}
