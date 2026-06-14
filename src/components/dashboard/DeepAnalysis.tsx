"use client";

import { useState } from "react";
import { Brain, Search, Loader2, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { useMarkets } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { signalLabelKey } from "@/lib/signal-engine";
import type { Recommendation, Direction } from "@/lib/signal-engine";
import type { Coin } from "@/lib/mock-data";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { deepAnalyze } from "@/lib/deep-analyze";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const DIR: Record<Direction, { cls: string; icon: React.ElementType }> = {
  LONG: { cls: "text-bull bg-bull/10 border-bull/30", icon: ArrowUpRight },
  SHORT: { cls: "text-bear bg-bear/10 border-bear/30", icon: ArrowDownRight },
  NEUTRAL: { cls: "text-gold bg-gold/10 border-gold/30", icon: Minus },
};

export function DeepAnalysis() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const [q, setQ] = useState("");
  const [coin, setCoin] = useState<Coin | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [text, setText] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [loading, setLoading] = useState(false);

  const matches = q.trim()
    ? coins.filter((c) => c.symbol.toLowerCase().includes(q.toLowerCase()) || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6)
    : [];
  const quick = ["BTC", "ETH", "SOL"].map((s) => coins.find((c) => c.symbol === s)).filter(Boolean) as Coin[];

  const analyze = async (c: Coin) => {
    setCoin(c);
    setQ("");
    setLoading(true);
    setText("");
    setRec(null);
    setProvider("");

    // Shared investor-grade analysis (klines engine + LLM with broad knowledge).
    const res = await deepAnalyze(c, lang);
    setRec(res.rec);
    setText(res.text);
    setProvider(res.provider);
    setLoading(false);
  };

  const d = rec ? DIR[rec.signal] : null;

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-violet/15 text-violet">
          <Brain className="h-5 w-5" strokeWidth={1.9} />
        </span>
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight">{t("da.title")}</h2>
          <p className="text-[11px] text-ink-faint">{t("da.sub")}</p>
        </div>
      </div>

      {/* search */}
      <div className="relative mt-4">
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("da.search")} className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none" />
        </div>
        {matches.length > 0 && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-white/10 bg-base-850 shadow-elev-2">
            {matches.map((c) => (
              <button key={c.symbol} onClick={() => analyze(c)} className="flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors hover:bg-white/[0.05]">
                <CoinIcon symbol={c.symbol} image={c.image} size={22} />
                <span className="text-sm font-semibold">{c.symbol}</span>
                <span className="truncate text-xs text-ink-faint">{c.name}</span>
                <span dir="ltr" className="ms-auto font-mono text-xs tnum">{formatUsd(c.price)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* quick picks */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {quick.map((c) => (
          <button key={c.symbol} onClick={() => analyze(c)} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-semibold text-ink-muted transition-colors hover:border-violet/40 hover:text-violet">
            <CoinIcon symbol={c.symbol} image={c.image} size={16} /> {c.symbol}
          </button>
        ))}
      </div>

      {/* result */}
      <div className="mt-4">
        {!coin ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-8 text-center text-sm text-ink-faint">{t("da.pick")}</div>
        ) : (
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            {/* header */}
            <div className="flex flex-wrap items-center gap-3">
              <CoinIcon symbol={coin.symbol} image={coin.image} size={32} />
              <div>
                <div className="text-sm font-bold">{coin.name}</div>
                <div dir="ltr" className="font-mono text-xs text-ink-muted tnum">{formatUsd(coin.price)} · {formatPercent(coin.change24h)}</div>
              </div>
              {rec && d && (
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider", d.cls)}>
                  <d.icon className="h-3.5 w-3.5" /> {t(signalLabelKey(rec.signal, "spot"))} · {rec.confidence}%
                </span>
              )}
              {provider && (
                <span className={cn("ms-auto rounded-full border px-2 py-0.5 text-[10px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
                  {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
                </span>
              )}
            </div>

            {/* trade plan grid */}
            {rec && rec.signal !== "NEUTRAL" && (
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                <Cell label={t("ms.entry")} v={formatUsd(rec.entry)} />
                <Cell label={t("ms.stop")} v={formatUsd(rec.stop)} tone="bear" />
                {rec.targets.map((tp, i) => <Cell key={i} label={`TP${i + 1}`} v={formatUsd(tp)} tone="bull" />)}
                <Cell label="R:R" v={`${rec.riskReward.toFixed(2)}:1`} />
              </div>
            )}

            {/* AI narrative */}
            <div className="mt-3 min-h-[80px] whitespace-pre-line rounded-xl bg-white/[0.03] p-4 text-sm leading-relaxed text-ink-muted">
              {loading ? (
                <span className="flex items-center gap-2 text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> {t("da.analyzing")}</span>
              ) : (
                text
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({ label, v, tone }: { label: string; v: string; tone?: "bull" | "bear" }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div dir="ltr" className={cn("mt-0.5 text-start font-mono text-xs font-semibold tnum", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-ink")}>{v}</div>
    </div>
  );
}
