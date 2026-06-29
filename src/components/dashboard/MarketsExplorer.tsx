"use client";

import { useMemo, useState } from "react";
import { Search, Star, ArrowUp, ArrowDown, TrendingUp, Compass } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import type { Coin } from "@/lib/mock-data";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { Sparkline } from "@/components/ui/Sparkline";
import { LivePrice } from "@/components/ui/LivePrice";
import { formatUsd, formatPercent, formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

type SortKey = "rank" | "price" | "change24h" | "change7d" | "marketCap" | "volume24h";
type Filter = "all" | "gainers" | "losers" | "favorites";

export function MarketsExplorer() {
  const { coins, isLive } = useMarkets();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "rank", dir: "asc" });
  const [favorites, setFavorites] = useState<Set<string>>(new Set(["BTC", "ETH", "SOL"]));
  const [limit, setLimit] = useState(60);

  const toggleFav = (s: string) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "rank" ? "asc" : "desc" }));

  const rows = useMemo(() => {
    let list = coins.slice();
    const query = q.trim().toLowerCase();
    if (query) list = list.filter((c) => c.symbol.toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
    if (filter === "gainers") list = list.filter((c) => c.change24h > 0);
    else if (filter === "losers") list = list.filter((c) => c.change24h < 0);
    else if (filter === "favorites") list = list.filter((c) => favorites.has(c.symbol));

    const dir = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = sort.key === "rank" ? (a.rank ?? 9999) : (a[sort.key] as number);
      const bv = sort.key === "rank" ? (b.rank ?? 9999) : (b[sort.key] as number);
      return (av - bv) * dir;
    });
    return list;
  }, [coins, q, filter, sort, favorites]);

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-cyan" />
            <h1 className="font-display text-2xl font-bold tracking-tight">{t("ex.title")}</h1>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-semibold text-ink-muted tnum">
              {coins.length} {t("ex.coins")}
            </span>
            <span className={cn("flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest", isLive ? "text-bull" : "text-gold")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse-glow" : "bg-gold")} /> {isLive ? t("ov.live") : t("ov.demo")}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-muted">{t("ex.subtitle")}</p>
        </div>
      </div>

      {/* controls */}
      <div className="glass glow-border flex flex-wrap items-center gap-3 rounded-2xl p-3">
        <div className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("ex.search")}
            className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
          {(["all", "gainers", "losers", "favorites"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn("rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors", filter === f ? "bg-white/10 text-ink" : "text-ink-muted hover:text-ink")}
            >
              {f === "all" ? t("ms.all") : t(`ex.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {/* table */}
      <div className="glass glow-border overflow-hidden rounded-2xl">
        <div className="hidden grid-cols-12 gap-2 border-b border-white/[0.06] px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-ink-faint md:grid">
          <button onClick={() => setSortKey("rank")} className="col-span-1 flex items-center gap-1 hover:text-ink">#<Sortcaret active={sort.key === "rank"} dir={sort.dir} /></button>
          <div className="col-span-3">{t("ex.name")}</div>
          <button onClick={() => setSortKey("price")} className="col-span-2 flex items-center justify-end gap-1 hover:text-ink">{t("ex.price")}<SortcaretActive k="price" sort={sort} /></button>
          <button onClick={() => setSortKey("change24h")} className="col-span-1 flex items-center justify-end gap-1 hover:text-ink">24h<SortcaretActive k="change24h" sort={sort} /></button>
          <button onClick={() => setSortKey("change7d")} className="col-span-1 flex items-center justify-end gap-1 hover:text-ink">7d<SortcaretActive k="change7d" sort={sort} /></button>
          <button onClick={() => setSortKey("marketCap")} className="col-span-2 flex items-center justify-end gap-1 hover:text-ink">{t("ex.marketCap")}<SortcaretActive k="marketCap" sort={sort} /></button>
          <div className="col-span-2 text-end">{t("ex.last7d")}</div>
        </div>

        <div className="divide-y divide-white/[0.05]">
          {rows.slice(0, limit).map((c) => (
            <CoinRow key={c.symbol} c={c} fav={favorites.has(c.symbol)} onFav={() => toggleFav(c.symbol)} />
          ))}
          {rows.length === 0 && <div className="px-4 py-12 text-center text-sm text-ink-muted">{t("ex.noResults")}</div>}
        </div>
      </div>

      {/* load more */}
      {rows.length > limit && (
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => setLimit((l) => l + 60)}
            className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-cyan/40 hover:text-cyan"
          >
            {t("ex.loadMore")}
          </button>
          <span className="text-[11px] text-ink-faint tnum">
            {t("ex.showing")} {Math.min(limit, rows.length)} / {rows.length}
          </span>
        </div>
      )}
    </div>
  );
}

function CoinRow({ c, fav, onFav }: { c: Coin; fav: boolean; onFav: () => void }) {
  const up24 = c.change24h >= 0;
  const up7 = c.change7d >= 0;
  return (
    <div className="grid grid-cols-12 items-center gap-2 px-4 py-3 transition-colors hover:bg-white/[0.02]">
      {/* rank + fav */}
      <div className="col-span-2 flex items-center gap-2 md:col-span-1">
        <button onClick={onFav} className={cn(fav ? "text-gold" : "text-ink-faint hover:text-ink-muted")}>
          <Star className="h-3.5 w-3.5" fill={fav ? "currentColor" : "none"} />
        </button>
        <span className="font-mono text-xs text-ink-faint tnum">{c.rank ?? "—"}</span>
      </div>
      {/* name */}
      <div className="col-span-6 flex items-center gap-2.5 md:col-span-3">
        <CoinIcon symbol={c.symbol} image={c.image} size={28} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{c.name}</div>
          <div className="text-[11px] text-ink-faint">{c.symbol}</div>
        </div>
      </div>
      {/* price */}
      <div dir="ltr" className="col-span-4 text-end font-mono text-sm tnum md:col-span-2">
        <LivePrice value={c.price} format={formatUsd} />
      </div>
      {/* 24h */}
      <div dir="ltr" className={cn("col-span-1 hidden text-end font-mono text-xs font-semibold tnum md:block", up24 ? "text-bull" : "text-bear")}>
        {formatPercent(c.change24h)}
      </div>
      {/* 7d */}
      <div dir="ltr" className={cn("col-span-1 hidden text-end font-mono text-xs font-semibold tnum md:block", up7 ? "text-bull" : "text-bear")}>
        {formatPercent(c.change7d)}
      </div>
      {/* market cap */}
      <div dir="ltr" className="col-span-2 hidden text-end font-mono text-xs text-ink-muted tnum md:block">${formatCompact(c.marketCap)}</div>
      {/* spark */}
      <div className="col-span-2 hidden items-center justify-end md:flex">
        {c.spark.length > 1 && <Sparkline data={c.spark} width={110} height={32} color={up7 ? "#00E676" : "#FF4D6D"} strokeWidth={1.6} />}
      </div>
    </div>
  );
}

function SortcaretActive({ k, sort }: { k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" } }) {
  if (sort.key !== k) return null;
  return sort.dir === "asc" ? <ArrowUp className="h-3 w-3 text-cyan" /> : <ArrowDown className="h-3 w-3 text-cyan" />;
}

function Sortcaret({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return null;
  return dir === "asc" ? <ArrowUp className="h-3 w-3 text-cyan" /> : <ArrowDown className="h-3 w-3 text-cyan" />;
}
