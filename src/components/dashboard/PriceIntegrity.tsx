"use client";

import { ShieldCheck, ShieldAlert, ShieldX, Activity, Gauge } from "lucide-react";
import { usePriceValidation } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import type { Verdict } from "@/lib/validation";
import type { SourceQuote } from "@/lib/exchanges";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const VERDICT: Record<Verdict, { key: string; cls: string; icon: React.ElementType; dot: string }> = {
  VALID: { key: "ov.verified", cls: "text-bull bg-bull/10 border-bull/30", icon: ShieldCheck, dot: "bg-bull" },
  CAUTION: { key: "ov.caution", cls: "text-gold bg-gold/10 border-gold/30", icon: ShieldAlert, dot: "bg-gold" },
  REJECT: { key: "ov.rejected", cls: "text-bear bg-bear/10 border-bear/30", icon: ShieldX, dot: "bg-bear" },
};

export function PriceIntegrity({ symbol = "BTC" }: { symbol?: string }) {
  const { data, isLoading } = usePriceValidation(symbol);
  const { t } = useI18n();

  if (isLoading || !data) return <Skeleton symbol={symbol} title={t("ov.priceIntegrity")} />;

  const v = VERDICT[data.verdict];
  const VIcon = v.icon;

  return (
    <div className="glass glow-border rounded-2xl p-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan" />
          <h2 className="text-sm font-semibold">{t("ov.priceIntegrity")}</h2>
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">{symbol}/USD</span>
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-bull">
            <span className="h-1.5 w-1.5 rounded-full bg-bull animate-pulse-glow" /> {t("ov.live")}
          </span>
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold tracking-widest", v.cls)}>
          <VIcon className="h-3.5 w-3.5" /> {t(v.key)}
        </span>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-12">
        {/* left: consensus price + scores */}
        <div className="lg:col-span-5">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">{t("ov.validatedPrice")}</div>
          <div dir="ltr" className="mt-1 text-start font-mono text-4xl font-bold tracking-tight tnum">
            {data.validatedPrice != null ? formatUsd(data.validatedPrice) : "—"}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span>{t("ov.median")} <span dir="ltr" className="font-mono text-ink tnum">{data.medianPrice != null ? formatUsd(data.medianPrice) : "—"}</span></span>
            <span>{t("ov.spread")} <span dir="ltr" className="font-mono text-ink tnum">{data.spreadPct.toFixed(3)}%</span></span>
            <span>{t("ov.consensus")} <span dir="ltr" className="font-mono text-ink tnum">{data.consensusCount}/{data.totalSources}</span></span>
          </div>

          <div className="mt-5 space-y-3">
            <ScoreBar label={t("ms.confidence")} value={data.confidence} icon={Gauge} />
            <ScoreBar label={t("ov.integrity")} value={data.integrity} icon={ShieldCheck} />
          </div>
        </div>

        {/* right: exchange grid */}
        <div className="lg:col-span-7">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint">
            <span>{t("ov.venue")}</span>
            <span>{symbol} · Δ% · ms</span>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {data.sources.map((s) => (
              <ExchangeRow key={s.exchange} s={s} />
            ))}
          </div>
        </div>
      </div>

      {/* reasons */}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", v.dot)} />
        {data.reasons.map((r, i) => (
          <span key={i} className="rounded-md bg-white/[0.04] px-2 py-1 text-[11px] text-ink-muted">{r}</span>
        ))}
      </div>
    </div>
  );
}

function ScoreBar({ label, value, icon: Icon }: { label: string; value: number; icon: React.ElementType }) {
  const color = value >= 70 ? "#00E676" : value >= 40 ? "#FFD166" : "#FF4D6D";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-ink-muted">
          <Icon className="h-3.5 w-3.5" /> {label}
        </span>
        <span className="font-mono font-semibold tnum" style={{ color }}>{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out-quint"
          style={{ width: `${value}%`, background: color, boxShadow: `0 0 10px ${color}88` }}
        />
      </div>
    </div>
  );
}

function ExchangeRow({ s }: { s: SourceQuote }) {
  const status = !s.ok ? "fail" : s.outlier ? "outlier" : "ok";
  const dot = status === "ok" ? "bg-bull" : status === "outlier" ? "bg-gold" : "bg-bear";
  const dev = s.deviationPct ?? 0;

  return (
    <div className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
        <span className="text-sm font-medium">{s.exchange}</span>
      </div>
      {s.ok ? (
        <div dir="ltr" className="flex items-center gap-3 text-right">
          <span className="font-mono text-xs text-ink tnum">{formatUsd(s.price!)}</span>
          <span className={cn("w-14 font-mono text-[11px] tnum", Math.abs(dev) > 0.8 ? "text-gold" : dev >= 0 ? "text-bull/80" : "text-bear/80")}>
            {dev >= 0 ? "+" : ""}{dev.toFixed(3)}%
          </span>
          <span className="w-12 font-mono text-[10px] text-ink-faint tnum">{s.latencyMs}ms</span>
        </div>
      ) : (
        <span className="font-mono text-[11px] text-ink-faint">{s.reason}</span>
      )}
    </div>
  );
}

function Skeleton({ symbol, title }: { symbol: string; title: string }) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-cyan" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-muted">{symbol}/USD</span>
        <span className="ms-auto text-[11px] text-ink-faint">8 ··· venues</span>
      </div>
      <div className="mt-5 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="shimmer h-10 w-48 rounded-lg bg-white/[0.05]" />
          <div className="shimmer mt-4 h-2 w-full rounded-full bg-white/[0.05]" />
          <div className="shimmer mt-3 h-2 w-full rounded-full bg-white/[0.05]" />
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:col-span-7">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="shimmer h-9 rounded-xl bg-white/[0.04]" />
          ))}
        </div>
      </div>
    </div>
  );
}
