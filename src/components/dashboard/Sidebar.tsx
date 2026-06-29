"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  LayoutDashboard,
  Brain,
  Layers,
  Waves,
  Fish,
  Grid3x3,
  Newspaper,
  Bot,
  History,
  Settings,
  Wallet,
  Compass,
  Radar,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Item = { icon: React.ElementType; key: string; href: string };

const groups: { key: string; items: Item[] }[] = [
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

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-e border-white/[0.06] bg-base-900/40 backdrop-blur-xl lg:flex">
      <div className="flex h-16 items-center gap-2.5 px-6">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-violet shadow-glow-violet">
          <Activity className="h-5 w-5 text-base-950" strokeWidth={2.5} />
        </span>
        <span className="font-display text-lg font-bold tracking-tight">
          Alslmany<span className="text-cyan"> Crypto</span>
        </span>
      </div>

      <nav className="flex-1 space-y-7 overflow-y-auto px-4 py-4">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-faint">{t(g.key)}</div>
            <div className="mt-2 space-y-1">
              {g.items.map((it) => {
                const active = pathname === it.href;
                const cls = cn(
                  "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active ? "bg-white/[0.06] text-ink" : "text-ink-muted hover:bg-white/[0.03] hover:text-ink"
                );
                return (
                  <Link key={it.key} href={it.href} className={cls}>
                    {active && <span className="absolute start-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-e-full bg-cyan-violet shadow-glow-cyan" />}
                    <it.icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-cyan")} strokeWidth={1.85} />
                    {t(it.key)}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="m-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet/15 text-violet">
            <Bot className="h-4 w-4" />
          </span>
          <div className="text-sm font-semibold">{t("nav.copilot")}</div>
          <span className="relative ms-auto flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-bull opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-bull" />
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{t("nav.copilotStatus")}</p>
      </div>

      <Link href="/dashboard/settings" className={cn(
        "mx-4 mb-4 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        pathname === "/dashboard/settings" ? "bg-white/[0.06] text-ink" : "text-ink-muted hover:text-ink"
      )}>
        <Settings className={cn("h-[18px] w-[18px]", pathname === "/dashboard/settings" && "text-cyan")} strokeWidth={1.85} /> {t("nav.settings")}
      </Link>
    </aside>
  );
}
