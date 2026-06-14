"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Compass, Layers, Radar, Bot } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const ITEMS = [
  { icon: LayoutDashboard, key: "mob.home", href: "/dashboard" },
  { icon: Compass, key: "mob.markets", href: "/dashboard/markets" },
  { icon: Layers, key: "mob.signals", href: "/dashboard/signals" },
  { icon: Radar, key: "mob.tracker", href: "/dashboard/tracker" },
  { icon: Bot, key: "mob.ai", href: "/dashboard/ai-trader" },
];

/** App-style bottom tab bar — phones/tablets only (the sidebar covers lg+). */
export function MobileNav() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav className="glass-strong fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="mx-auto flex max-w-md items-stretch justify-around">
        {ITEMS.map((it) => {
          const active = pathname === it.href;
          return (
            <Link
              key={it.href}
              href={it.href}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-semibold transition-colors",
                active ? "text-cyan" : "text-ink-faint hover:text-ink-muted"
              )}
            >
              {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-cyan-violet shadow-glow-cyan" />}
              <it.icon className="h-5 w-5" strokeWidth={active ? 2.2 : 1.8} />
              <span>{t(it.key)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
