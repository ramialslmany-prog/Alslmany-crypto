"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, TrendingUp, CornerDownLeft, LayoutDashboard, Compass, Radar, Wallet, Bot, Brain, Layers, Waves, Fish, History, Grid3x3, Newspaper, Settings } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type PageItem = { icon: React.ElementType; key: string; href: string };

const PAGES: PageItem[] = [
  { icon: LayoutDashboard, key: "nav.overview", href: "/dashboard" },
  { icon: Compass, key: "nav.markets", href: "/dashboard/markets" },
  { icon: Radar, key: "nav.tracker", href: "/dashboard/tracker" },
  { icon: Wallet, key: "nav.portfolio", href: "/dashboard/portfolio" },
  { icon: Bot, key: "nav.aiTrader", href: "/dashboard/ai-trader" },
  { icon: Brain, key: "nav.aiSignals", href: "/dashboard/ai" },
  { icon: Layers, key: "nav.manualSignals", href: "/dashboard/signals" },
  { icon: Waves, key: "nav.smartMoney", href: "/dashboard/smart-money" },
  { icon: Fish, key: "nav.whaleFlow", href: "/dashboard/whales" },
  { icon: History, key: "nav.backtest", href: "/dashboard/backtest" },
  { icon: Grid3x3, key: "nav.heatmap", href: "/dashboard/heatmap" },
  { icon: Newspaper, key: "nav.news", href: "/dashboard/news" },
  { icon: Settings, key: "nav.settings", href: "/dashboard/settings" },
];

/** Global ⌘K command palette: fuzzy coin search → analysis page, plus quick nav. */
export function CommandPalette() {
  const router = useRouter();
  const { coins } = useMarkets();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Open on ⌘K / Ctrl+K, or a custom event from the Topbar/mobile triggers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("cmdk:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cmdk:open", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const query = q.trim().toLowerCase();
  const coinResults = useMemo(() => {
    if (!query) return coins.slice(0, 6);
    return coins
      .filter((c) => c.symbol.toLowerCase().includes(query) || c.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [coins, query]);

  const pageResults = useMemo(() => {
    if (!query) return PAGES.slice(0, 4);
    return PAGES.filter((p) => t(p.key).toLowerCase().includes(query) || p.href.includes(query)).slice(0, 5);
  }, [query, t]);

  // Flat list for keyboard navigation: coins first, then pages.
  const flat = useMemo(
    () => [
      ...coinResults.map((c) => ({ kind: "coin" as const, href: `/dashboard/coin/${c.symbol}`, coin: c })),
      ...pageResults.map((p) => ({ kind: "page" as const, href: p.href, page: p })),
    ],
    [coinResults, pageResults]
  );

  useEffect(() => {
    if (active >= flat.length) setActive(0);
  }, [flat.length, active]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[active];
      if (item) go(item.href);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-base-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-base-900/95 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={t("cmd.placeholder")}
            className="w-full bg-transparent py-4 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="hidden rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-ink-faint sm:block">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-2">
          {flat.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-ink-faint">{t("cmd.empty")}</div>
          )}

          {coinResults.length > 0 && (
            <div className="mb-1 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{t("cmd.coins")}</div>
          )}
          {coinResults.map((c) => {
            const i = flat.findIndex((f) => f.kind === "coin" && f.href.endsWith(`/${c.symbol}`));
            return (
              <button
                key={c.symbol}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(`/dashboard/coin/${c.symbol}`)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start transition-colors", active === i ? "bg-white/[0.07]" : "hover:bg-white/[0.03]")}
              >
                <CoinIcon symbol={c.symbol} image={c.image} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{c.name}</div>
                  <div className="text-[11px] text-ink-faint">{c.symbol}</div>
                </div>
                <span dir="ltr" className="font-mono text-xs text-ink-muted tnum">{formatUsd(c.price)}</span>
                <span dir="ltr" className={cn("flex items-center gap-0.5 font-mono text-[11px] font-semibold tnum", (c.change24h ?? 0) >= 0 ? "text-bull" : "text-bear")}>
                  <TrendingUp className={cn("h-3 w-3", (c.change24h ?? 0) < 0 && "rotate-180")} />
                  {Math.abs(c.change24h ?? 0).toFixed(1)}%
                </span>
                {active === i && <CornerDownLeft className="h-3.5 w-3.5 text-ink-faint" />}
              </button>
            );
          })}

          {pageResults.length > 0 && (
            <div className="mb-1 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{t("cmd.pages")}</div>
          )}
          {pageResults.map((p) => {
            const i = flat.findIndex((f) => f.kind === "page" && f.href === p.href);
            return (
              <button
                key={p.href}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(p.href)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start transition-colors", active === i ? "bg-white/[0.07]" : "hover:bg-white/[0.03]")}
              >
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.05] text-ink-muted"><p.icon className="h-4 w-4" /></span>
                <span className="flex-1 text-sm font-medium">{t(p.key)}</span>
                {active === i && <CornerDownLeft className="h-3.5 w-3.5 text-ink-faint" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
