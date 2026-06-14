"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Bell, Search, Command } from "lucide-react";
import { useFearGreed } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { LangToggle } from "@/components/ui/LangToggle";

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
  const meta = TITLE_KEYS[pathname] ?? TITLE_KEYS["/dashboard"];
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setTime(fmt());
    const id = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-white/[0.06] bg-base-950/70 px-5 backdrop-blur-xl">
      <div>
        <h1 className="font-display text-lg font-bold tracking-tight">{t(meta.title)}</h1>
        <p className="text-xs text-ink-faint">{t(meta.sub)}</p>
      </div>

      {/* search */}
      <div className="ms-auto hidden items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-ink-muted md:flex md:w-72">
        <Search className="h-4 w-4 shrink-0" />
        <input
          placeholder={t("top.search")}
          className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <span className="flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-ink-faint">
          <Command className="h-3 w-3" />K
        </span>
      </div>

      <div className="hidden items-center gap-2 rounded-xl border border-gold/25 bg-gold/[0.08] px-3 py-2 sm:flex">
        <span className="h-2 w-2 rounded-full bg-gold animate-pulse-glow" />
        <span className="text-xs font-medium text-gold">
          <span className="tnum">{fg.value}</span> · {t(`fg.${fg.classification}`)}
        </span>
      </div>

      <LangToggle />

      <button className="relative grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-ink-muted transition-colors hover:text-ink">
        <Bell className="h-[18px] w-[18px]" />
        <span className="absolute end-2.5 top-2.5 h-2 w-2 rounded-full bg-bear" />
      </button>

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
