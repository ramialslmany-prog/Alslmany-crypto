"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Target, Loader2, Send, Flame, ArrowUpRight } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { scanCoin } from "@/lib/scan-engine";
import { qualityScore } from "@/lib/signal-engine";
import { isStable, liqBonus } from "@/lib/coin-meta";
import { useI18n } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { cn } from "@/lib/utils";

const GOOD_BAR = 70; // shown in the in-app feed
const IDEAL_BAR = 85; // "🔥 ideal" tier + Telegram alert
const ALERT_KEY = "quantum.aiopps.alerted"; // symbol -> last alert ts (12h dedup)
const ALERT_TTL = 12 * 3600e3;

type Opp = { symbol: string; name: string; image?: string; conf: number; entry: number; stop: number; targets: number[]; rr: number; rank: number };

export function AIOpportunities() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [opps, setOpps] = useState<Opp[]>([]);
  const [scannedAt, setScannedAt] = useState(0);
  const [tgOn, setTgOn] = useState(true);
  const [tgConfigured, setTgConfigured] = useState(false);
  const tgOnRef = useRef(tgOn);
  tgOnRef.current = tgOn;
  const coinsRef = useRef(coins);
  coinsRef.current = coins;

  useEffect(() => {
    fetch("/api/telegram").then((r) => r.json()).then((j) => setTgConfigured(!!j.configured)).catch(() => {});
  }, []);

  // Auto-scan 300 coins for the best LONG setups — runs on its own every 90s.
  useEffect(() => {
    const scan = () => {
      const cs = coinsRef.current;
      if (!cs.length) return;
      const found = cs
        .filter((c) => !isStable(c.symbol) && (c.rank ?? 999) <= 200)
        .map((c) => ({ c, r: scanCoin(c, "day", "spot") }))
        .filter((x) => x.r.signal === "LONG" && x.r.trend === "up" && x.r.confidence >= GOOD_BAR)
        .map((x) => ({ ...x, score: qualityScore(x.r) + liqBonus(x.c.rank) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((x): Opp => ({
          symbol: x.c.symbol, name: x.c.name, image: x.c.image,
          conf: x.r.confidence, entry: x.r.entry, stop: x.r.stop, targets: x.r.targets,
          rr: x.r.riskReward, rank: x.c.rank ?? 999,
        }));
      setOpps(found);
      setScannedAt(Date.now());

      // Notify Telegram about NEW ideal opportunities (deduped 12h).
      if (tgOnRef.current) {
        let map: Record<string, number> = {};
        try { map = JSON.parse(localStorage.getItem(ALERT_KEY) || "{}"); } catch { /* ignore */ }
        const now = Date.now();
        for (const o of found) {
          if (o.conf < IDEAL_BAR) continue;
          if (map[o.symbol] && now - map[o.symbol] < ALERT_TTL) continue;
          map[o.symbol] = now;
          const tp1 = ((o.targets[0] - o.entry) / o.entry) * 100;
          const text =
            `🎯 فرصة مثالية اكتشفها الذكاء\n\n#${o.symbol}/USDT - طويل🟢\nالثقة: ${o.conf}%\n\nنقطة الدخول: ${fmt(o.entry)}\nوقف الخسارة: ${fmt(o.stop)}\nالهدف 1: ${fmt(o.targets[0])} (+${tp1.toFixed(1)}%)\nالهدف 2: ${fmt(o.targets[1])}\nالهدف 3: ${fmt(o.targets[2])}\n\n⚠️ ليست نصيحة مالية`;
          fetch("/api/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => {});
        }
        try { localStorage.setItem(ALERT_KEY, JSON.stringify(map)); } catch { /* ignore */ }
      }
    };
    const first = setTimeout(scan, 2500);
    const id = setInterval(scan, 90_000);
    return () => { clearTimeout(first); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ideal = useMemo(() => opps.filter((o) => o.conf >= IDEAL_BAR).length, [opps]);

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gold/15 text-gold"><Target className="h-5 w-5" /></span>
          <div>
            <h2 className="font-display text-lg font-bold">{t("op.title")}</h2>
            <p className="text-xs text-ink-muted">{t("op.sub")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-bull/30 bg-bull/10 px-2.5 py-1 text-[11px] font-bold text-bull">
            <span className="h-1.5 w-1.5 rounded-full bg-bull animate-pulse" /> {t("op.scanning")}
          </span>
          {tgConfigured && (
            <button
              onClick={() => setTgOn((v) => !v)}
              title={t("op.tgToggle")}
              className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors",
                tgOn ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-white/10 bg-white/[0.04] text-ink-faint")}
            >
              <Send className="h-3 w-3" /> {tgOn ? t("op.tgOn") : t("op.tgOff")}
            </button>
          )}
        </div>
      </div>

      {ideal > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-gold/25 bg-gold/[0.07] px-3 py-2 text-sm font-semibold text-gold">
          <Flame className="h-4 w-4" /> {t("op.idealFound").replace("{n}", String(ideal))}
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {opps.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">
            {scannedAt === 0 ? <Loader2 className="h-4 w-4 animate-spin text-cyan" /> : null}
            {scannedAt === 0 ? t("op.scanningNow") : t("op.none")}
          </div>
        ) : (
          opps.map((o) => {
            const isIdeal = o.conf >= IDEAL_BAR;
            const tp1 = ((o.targets[0] - o.entry) / o.entry) * 100;
            return (
              <div key={o.symbol} className={cn("flex flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2.5",
                isIdeal ? "border-gold/30 bg-gold/[0.05]" : "border-white/[0.06] bg-white/[0.02]")}>
                <CoinIcon symbol={o.symbol} image={o.image} size={26} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold">{o.symbol}</span>
                    {isIdeal && <span className="inline-flex items-center gap-0.5 rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-gold"><Flame className="h-2.5 w-2.5" /> {t("op.ideal")}</span>}
                  </div>
                  <div className="truncate text-[11px] text-ink-faint">{o.name}</div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">
                  <ArrowUpRight className="h-3 w-3" /> {t("dir.BUY")}
                </span>
                <span dir="ltr" className="hidden font-mono text-[11px] text-ink-muted tnum sm:inline">
                  {fmt(o.entry)} · 🛑 {fmt(o.stop)} · 🎯 {fmt(o.targets[0])} <span className="text-bull">(+{tp1.toFixed(1)}%)</span>
                </span>
                <div className="ms-auto flex items-center gap-3">
                  <span dir="ltr" className="text-[10px] text-ink-faint tnum">R:R {o.rr.toFixed(1)}</span>
                  <span dir="ltr" className={cn("font-mono text-sm font-bold tnum", isIdeal ? "text-gold" : "text-bull")}>{o.conf}%</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="mt-3 text-center text-[11px] text-ink-faint">{t("op.note")}</p>
    </div>
  );
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
};
