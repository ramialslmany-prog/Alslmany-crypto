"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Sparkles, PlayCircle, GraduationCap, Loader2, Trash2, ArrowUpRight, Gauge, Send } from "lucide-react";
import { useJournal, clearJournal, journalStats, adaptiveMinConf, getLessons, type JTrade } from "@/lib/ai-journal";
import { autoIssue, maybeSelfReview } from "@/lib/trader-engine";
import { useMarkets } from "@/lib/hooks";
import { useI18n, timeAgo } from "@/lib/i18n";
import { CoinIcon } from "@/components/ui/CoinIcon";
import { formatUsd, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_CLS: Record<JTrade["status"], string> = {
  open: "text-cyan bg-cyan/10 border-cyan/30",
  tp1: "text-bull bg-bull/10 border-bull/30",
  tp2: "text-bull bg-bull/10 border-bull/30",
  tp3: "text-bull bg-bull/12 border-bull/40",
  breakeven: "text-ink-muted bg-white/[0.06] border-white/15",
  stopped: "text-bear bg-bear/10 border-bear/30",
  expired: "text-gold bg-gold/10 border-gold/30",
};

export function AITrader() {
  const { coins } = useMarkets();
  const { t, lang } = useI18n();
  const journal = useJournal();

  const [issuing, setIssuing] = useState(false);
  const [comment, setComment] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState("");
  const [provider, setProvider] = useState<"ai" | "local" | "">("");
  const [lessons, setLessonsState] = useState("");
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);

  useEffect(() => setLessonsState(getLessons()), []);

  // Telegram bridge status (token in .env.local → server-side only).
  useEffect(() => {
    (async () => {
      try {
        const j = (await (await fetch("/api/telegram")).json()) as { configured?: boolean };
        setTgConfigured(!!j.configured);
      } catch {
        setTgConfigured(false);
      }
    })();
  }, []);

  const priceOf = (s: string) => coins.find((c) => c.symbol === s)?.price ?? 0;
  const imageOf = (s: string) => coins.find((c) => c.symbol === s)?.image;

  // Evaluation + Telegram alerts run globally in <JournalWatcher /> (dashboard
  // layout) so picks are monitored from ANY page — nothing to do here.

  const stats = useMemo(() => journalStats(journal), [journal]);
  const minConf = adaptiveMinConf(stats);
  const open = journal.filter((x) => x.status === "open");
  const closed = journal.filter((x) => x.status !== "open");

  const statusLabel = (s: JTrade["status"]) =>
    s === "open" ? t("status.active") : s === "expired" ? t("at.expired") : s === "breakeven" ? t("at.breakeven") : t(`status.${s}`);

  /** Manual "enter now" — same strict engine as the autonomous watcher. */
  const issue = async () => {
    if (issuing || !coins.length) return;
    setIssuing(true);
    setComment("");
    const res = await autoIssue(coins, journal, lang, true);
    setComment(res.comment);
    setProvider(res.provider);
    setIssuing(false);
  };

  /** Manual re-review — same engine the autonomous watcher uses on closures. */
  const doReview = async () => {
    if (reviewing || !closed.length) return;
    setReviewing(true);
    setReview("");
    const res = await maybeSelfReview(journal, lang, true);
    if (res) {
      setReview(res.review);
      setProvider(res.provider);
      setLessonsState(getLessons());
    }
    setReviewing(false);
  };

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet/15 text-violet">
            <Bot className="h-5 w-5" strokeWidth={1.9} />
          </span>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{t("at.title")}</h1>
            <p className="text-sm text-ink-muted">{t("at.sub")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-violet/30 bg-violet/10 px-3 py-1 text-[11px] font-bold text-violet">{t("at.loop")}</span>
          <span className="flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-[11px] font-bold text-gold">
            <Gauge className="h-3 w-3" /> {t("at.adaptive")}: <span dir="ltr" className="tnum">≥{minConf}%</span>
          </span>
          <span
            title={tgConfigured ? undefined : t("at.tgHint")}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold",
              tgConfigured ? "border-cyan/30 bg-cyan/10 text-cyan" : "border-white/10 bg-white/[0.04] text-ink-faint"
            )}
          >
            <Send className="h-3 w-3" /> {tgConfigured ? t("at.tgOn") : t("at.tgOff")}
          </span>
          {journal.length > 0 && (
            <button onClick={clearJournal} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint transition-colors hover:text-bear">
              <Trash2 className="h-3.5 w-3.5" /> {t("tr.clear")}
            </button>
          )}
        </div>
      </div>

      {/* actions */}
      <div className="flex flex-wrap gap-2">
        <button onClick={issue} disabled={issuing} className="inline-flex items-center gap-2 rounded-xl bg-cyan-violet px-5 py-2.5 text-sm font-bold text-base-950 transition-transform hover:scale-[1.02] disabled:opacity-50">
          {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} {issuing ? t("at.issuing") : t("at.issue")}
        </button>
        <button onClick={doReview} disabled={reviewing || !closed.length} title={!closed.length ? t("at.needClosed") : undefined} className="inline-flex items-center gap-2 rounded-xl border border-violet/40 bg-violet/10 px-5 py-2.5 text-sm font-bold text-violet transition-colors hover:bg-violet/20 disabled:opacity-40">
          {reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <GraduationCap className="h-4 w-4" />} {reviewing ? t("at.reviewing") : t("at.review")}
        </button>
      </div>
      <p className="text-xs text-ink-faint">{t("at.autoReview")}</p>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={t("at.openTrades")} v={String(stats.open)} color="#00D4FF" />
        <Kpi label={t("at.closedTrades")} v={String(stats.closed)} color="#7C4DFF" />
        <Kpi label={lang === "ar" ? "نسبة الربح" : "Win rate"} v={`${stats.winRate.toFixed(0)}%`} color={stats.winRate >= 50 ? "#00E676" : "#FF4D6D"} ltr />
        <Kpi label={lang === "ar" ? "العائد الكلي" : "Total return"} v={formatPercent(stats.totalPct)} color={stats.totalPct >= 0 ? "#00E676" : "#FF4D6D"} ltr />
        <Kpi label={lang === "ar" ? "معامل الربح" : "Profit factor"} v={stats.profitFactor.toFixed(2)} color="#FFD166" ltr />
      </div>

      {/* lessons (the learning memory) */}
      {lessons && (
        <div className="glass glow-border rounded-2xl border-violet/20 p-4">
          <div className="mb-1.5 flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-violet" />
            <span className="text-xs font-bold uppercase tracking-wider text-violet">{t("at.lessons")}</span>
          </div>
          <p className="whitespace-pre-line text-xs leading-relaxed text-ink-muted">{lessons}</p>
        </div>
      )}

      {/* AI comment on latest picks */}
      {comment && (
        <div className="glass rounded-2xl p-4">
          <div className="mb-1.5 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-cyan" />
            <span className="text-xs font-bold uppercase tracking-wider text-cyan">{t("at.comment")}</span>
            <Badge provider={provider} t={t} />
          </div>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">{comment}</p>
        </div>
      )}

      {/* self-review */}
      {review && (
        <div className="glass glow-border rounded-2xl p-4">
          <div className="mb-1.5 flex items-center gap-2">
            <Bot className="h-4 w-4 text-violet" />
            <span className="text-xs font-bold uppercase tracking-wider text-violet">{t("at.selfReview")}</span>
            <Badge provider={provider} t={t} />
          </div>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink-muted">{review}</p>
        </div>
      )}

      {/* open picks */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <PlayCircle className="h-4 w-4 text-cyan" /> {t("at.openTrades")}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted tnum">{open.length}</span>
        </div>
        {open.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-7 text-center text-sm text-ink-faint">{t("at.empty")}</div>
        ) : (
          <div className="space-y-1.5">
            {open.map((x) => {
              const p = priceOf(x.symbol) || x.entry;
              const live = ((p - x.entry) / x.entry) * 100;
              return (
                <div key={x.id} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                  <CoinIcon symbol={x.symbol} image={imageOf(x.symbol)} size={24} />
                  <span className="text-sm font-bold">{x.symbol}</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-bull/30 bg-bull/10 px-2 py-0.5 text-[11px] font-bold text-bull">
                    <ArrowUpRight className="h-3 w-3" /> {t("dir.BUY")}
                  </span>
                  {(x.hit ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] font-bold text-gold" title={t("at.stopSecured")}>
                      🎯 {x.hit}/3 · 🔒
                    </span>
                  )}
                  <span className="hidden text-[11px] text-ink-faint sm:inline">{timeAgo(x.issuedAt, t)}</span>
                  <span dir="ltr" className="font-mono text-[11px] text-ink-muted tnum">{formatUsd(x.entry)} → {formatUsd(p)}</span>
                  <span dir="ltr" className={cn("ms-auto font-mono text-sm font-bold tnum", live >= 0 ? "text-bull" : "text-bear")}>{formatPercent(live)}</span>
                  <span dir="ltr" className="font-mono text-[10px] text-ink-faint tnum">conf {x.confidence}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* closed picks */}
      <div className="glass glow-border rounded-2xl p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <GraduationCap className="h-4 w-4 text-violet" /> {t("at.closedTrades")}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-muted tnum">{closed.length}</span>
        </div>
        {closed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-sm text-ink-faint">{t("at.noClosed")}</div>
        ) : (
          <div className="max-h-[340px] space-y-1.5 overflow-y-auto pe-1">
            {closed.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <CoinIcon symbol={x.symbol} image={imageOf(x.symbol)} size={24} />
                <span className="text-sm font-bold">{x.symbol}</span>
                <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[x.status])}>{statusLabel(x.status)}</span>
                <span className="hidden text-[11px] text-ink-faint sm:inline">{x.closedAt ? timeAgo(x.closedAt, t) : ""}</span>
                <span dir="ltr" className={cn("ms-auto font-mono text-sm font-bold tnum", (x.retPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>{formatPercent(x.retPct ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[11px] text-ink-faint">{t("ms.disclaimer")}</p>
    </div>
  );
}

function Badge({ provider, t }: { provider: "ai" | "local" | ""; t: (k: string) => string }) {
  if (!provider) return null;
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", provider === "ai" ? "border-bull/30 bg-bull/10 text-bull" : "border-white/10 bg-white/[0.04] text-ink-muted")}>
      {provider === "ai" ? t("ai.viaAI") : t("ai.viaLocal")}
    </span>
  );
}

function Kpi({ label, v, color, ltr }: { label: string; v: string; color: string; ltr?: boolean }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div dir={ltr ? "ltr" : undefined} className="font-display text-2xl font-bold tracking-tight tnum" style={{ color }}>{v}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
    </div>
  );
}
