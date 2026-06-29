"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, TrendingUp, TrendingDown } from "lucide-react";
import { useMarkets, useFearGreed, useGlobal, useLiveTickers } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { Sparkline } from "@/components/ui/Sparkline";
import { LivePrice } from "@/components/ui/LivePrice";
import { formatUsd, formatCompact, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Signature command-center hero: a time-aware greeting, an honest market read
 *  derived from the real Fear & Greed index, and live pulse tiles. Asymmetric
 *  by design — the headline dominates, the data sits to the side. */
export function MarketPulse() {
  const { coins } = useMarkets();
  const fg = useFearGreed();
  const { data: global } = useGlobal();
  const { prices: livePrices, connected } = useLiveTickers(["BTC", "ETH", "SOL"]);
  const { t, lang } = useI18n();
  const [hour, setHour] = useState(12);
  useEffect(() => setHour(new Date().getHours()), []);

  const greet =
    hour < 5 ? t("pulse.night") : hour < 12 ? t("pulse.morning") : hour < 18 ? t("pulse.afternoon") : t("pulse.evening");

  // Honest market read from the real F&G value.
  const read =
    fg.value <= 25 ? t("pulse.r1") : fg.value <= 45 ? t("pulse.r2") : fg.value < 55 ? t("pulse.r3") : fg.value < 75 ? t("pulse.r4") : t("pulse.r5");

  const get = (s: string) => coins.find((c) => c.symbol === s);
  const tiles = ["BTC", "ETH", "SOL"].map(get).filter(Boolean) as NonNullable<ReturnType<typeof get>>[];

  const fgColor = fg.value <= 25 ? "#FF4D6D" : fg.value < 55 ? "#FFD166" : "#00E676";

  return (
    <section className="glass-strong glow-border relative overflow-hidden rounded-3xl">
      {/* decorative signature orb */}
      <div aria-hidden className="pointer-events-none absolute -top-24 -end-16 h-72 w-72 rounded-full bg-cyan-violet opacity-[0.16] blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-20 start-1/3 h-56 w-56 rounded-full bg-violet opacity-[0.1] blur-3xl" />

      <div className="relative grid gap-6 p-6 lg:grid-cols-12 lg:items-center lg:gap-4 lg:p-8">
        {/* headline zone — dominant */}
        <div className="lg:col-span-7">
          <div className="flex items-center gap-2 text-xs font-medium text-cyan">
            <span className="relative flex h-2 w-2">
              <span className={cn("absolute inline-flex h-2 w-2 animate-ping rounded-full opacity-70", connected ? "bg-bull" : "bg-cyan")} />
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", connected ? "bg-bull" : "bg-cyan")} />
            </span>
            {greet}
            {connected && <span className="ms-1 rounded-full border border-bull/30 bg-bull/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-bull">{t("ov.live")} WS</span>}
          </div>
          <h1 className="mt-2 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            <span className="text-gradient">{t("pulse.title")}</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">{read}</p>

          {/* fear & greed inline meter */}
          <div className="mt-5 flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4" style={{ color: fgColor }} />
              <span className="text-xs text-ink-faint">{t("pulse.fg")}</span>
            </div>
            <div className="relative h-1.5 w-40 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${fg.value}%`, background: fgColor }} />
            </div>
            <span dir="ltr" className="text-sm font-bold tnum" style={{ color: fgColor }}>{fg.value}</span>
            <span className="text-xs text-ink-muted">{t(`fg.${fg.classification}`)}</span>
          </div>

          {/* global market stats */}
          {global && global.totalMcap > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
              <GlobalStat label={t("pulse.totalCap")} value={`$${formatCompact(global.totalMcap)}`} sub={formatPercent(global.mcapChange24h)} subTone={global.mcapChange24h >= 0 ? "bull" : "bear"} />
              <GlobalStat label={t("pulse.btcDom")} value={`${global.btcDominance.toFixed(1)}%`} />
              <GlobalStat label={t("pulse.vol24")} value={`$${formatCompact(global.totalVol)}`} />
            </div>
          )}
        </div>

        {/* live pulse tiles — secondary, asymmetric */}
        <div className="grid grid-cols-3 gap-2.5 lg:col-span-5">
          {tiles.map((c) => {
            const up = (c.change24h ?? 0) >= 0;
            return (
              <Link key={c.symbol} href={`/dashboard/coin/${c.symbol}`} className="glass rounded-2xl p-3 transition-colors hover:border-cyan/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">{c.symbol}</span>
                  <span dir="ltr" className={cn("flex items-center gap-0.5 text-[10px] font-bold tnum", up ? "text-bull" : "text-bear")}>
                    {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                    {up ? "+" : ""}{(c.change24h ?? 0).toFixed(1)}%
                  </span>
                </div>
                <div dir="ltr" className="mt-1 font-mono text-sm font-bold tnum">
                  <LivePrice value={livePrices[c.symbol] ?? c.price} format={formatUsd} />
                </div>
                {c.spark?.length > 1 && (
                  <div className="mt-1.5 [&_svg]:h-auto [&_svg]:w-full">
                    <Sparkline data={c.spark} width={120} height={28} color={up ? "#00E676" : "#FF4D6D"} strokeWidth={1.5} fill={false} />
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GlobalStat({ label, value, sub, subTone }: { label: string; value: string; sub?: string; subTone?: "bull" | "bear" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span dir="ltr" className="font-mono text-sm font-bold tnum text-ink">{value}</span>
        {sub && <span dir="ltr" className={cn("font-mono text-[10px] font-semibold tnum", subTone === "bull" ? "text-bull" : "text-bear")}>{sub}</span>}
      </div>
    </div>
  );
}
