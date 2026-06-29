"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Search, Command } from "lucide-react";
import { useFearGreed } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { LangToggle } from "@/components/ui/LangToggle";
import { MobileMenu } from "@/components/dashboard/MobileMenu";
import { NotificationBell } from "@/components/dashboard/NotificationBell";

const TITLE_KEYS: Record<string, { title: string; sub: string }> = {
  "/dashboard": { title: "top.overview.title", sub: "top.overview.sub" },
  "/dashboard/markets": { title: "top.markets.title", sub: "top.markets.sub" },
  "/dashboard/signals": { title: "top.signals.title", sub: "top.signals.sub" },
  "/dashboard/tracker": { title: "top.tracker.title", sub: "top.tracker.sub" },
  "/dashboard/portfolio": { title: "top.portfolio.title", sub: "top.portfolio.sub" },
  "/dashboard/heatmap": { title: "nav.heatmap", sub: "top.overview.sub" },
  "/dashboard/whales": { title: "nav.whaleFlow", sub: "top.overview.sub" },
  "/dashboard/news": { title: "nav.news", sub: "top.news.sub" },
  "/dashboard/ai": { title: "nav.aiSignals", sub: "top.overview.sub" },
  "/dashboard/ai-trader": { title: "nav.aiTrader", sub: "top.aitrader.sub" },
  "/dashboard/smart-money": { title: "sm.title", sub: "sm.sub" },
  "/dashboard/backtest": { title: "bt.title", sub: "bt.sub" },
  "/dashboard/settings": { title: "set.title", sub: "set.sub" },
};

export function Topbar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const fg = useFearGreed();
  const isCoin = pathname.startsWith("/dashboard/coin/");
  const coinSym = isCoin ? decodeURIComponent(pathname.split("/").pop() ?? "").toUpperCase() : "";
  const meta = TITLE_KEYS[pathname] ?? TITLE_KEYS["/dashboard"];
  const [time, setTime] = useState<string>("");
  const openSearch = () => window.dispatchEvent(new Event("cmdk:open"));

  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setTime(fmt());
    const id = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.06] bg-base-950/70 px-3 backdrop-blur-xl sm:gap-4 sm:px-5">
      <MobileMenu />
      <div className="min-w-0">
        <h1 className="truncate font-display text-base font-bold tracking-tight sm:text-lg">{isCoin ? `${coinSym}/USD` : t(meta.title)}</h1>
        <p className="truncate text-[11px] text-ink-faint sm:text-xs">{isCoin ? t("top.coin.sub") : t(meta.sub)}</p>
      </div>

      {/* search — opens the global ⌘K command palette */}
      <button
        onClick={openSearch}
        className="ms-auto hidden items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-ink-faint transition-colors hover:border-white/15 hover:text-ink-muted md:flex md:w-72"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-start">{t("top.search")}</span>
        <span className="flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px]">
          <Command className="h-3 w-3" />K
        </span>
      </button>
      {/* mobile search trigger */}
      <button onClick={openSearch} aria-label={t("top.search")} className="ms-auto grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-ink-muted transition-colors hover:text-ink md:hidden">
        <Search className="h-[18px] w-[18px]" />
      </button>

      <div className="hidden items-center gap-2 rounded-xl border border-gold/25 bg-gold/[0.08] px-3 py-2 sm:flex">
        <span className="h-2 w-2 rounded-full bg-gold animate-pulse-glow" />
        <span className="text-xs font-medium text-gold">
          <span className="tnum">{fg.value}</span> · {t(`fg.${fg.classification}`)}
        </span>
      </div>

      <LangToggle />

      <NotificationBell />

      <div className="flex items-center gap-2.5">
        <div className="hidden text-end sm:block">
          <div className="text-xs font-medium text-ink tnum">UTC {time}</div>
          <div className="text-[10px] text-ink-faint">{t("top.session")}</div>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-violet text-sm font-bold text-base-950">A</span>
      </div>
    </header>
  );
}
