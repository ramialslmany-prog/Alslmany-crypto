"use client";

import { useState } from "react";
import { Check, Send, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useTelegram } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { Tag } from "@/components/ui/Tag";
import { Num } from "@/components/ui/Num";
import { LangToggle } from "@/components/ui/LangToggle";
import { DEFAULT_BOT_CONFIG } from "@/lib/bot/types";
import { DEFAULT_RISK } from "@/lib/engine/risk";
import { UNIVERSE } from "@/lib/market/universe";

/**
 * Settings.
 *
 * The risk rules are displayed as facts rather than controls, because that is
 * what they are: they are compiled into the engine and applied to every trade.
 * Rendering them as toggles would imply a user could loosen them from here,
 * which would be a lie told by an interface.
 */
export function SettingsView() {
  const { t, lang } = useI18n();
  const { data: telegram, refetch } = useTelegram();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const sendTest = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/telegram", { method: "POST" });
      const body = (await res.json()) as { ok: boolean; data?: { sent: boolean } };
      setSent(Boolean(body.ok && body.data?.sent));
    } catch {
      setSent(false);
    } finally {
      setSending(false);
      refetch();
    }
  };

  const configured = telegram?.data.configured && telegram.data.chatResolved;

  return (
    <>
      <PageHeader title={t("term.settings.title")} />

      <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-2">
        <Section title={t("term.settings.language")}>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-muted">{t("lang.current")}</span>
            <LangToggle />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            {lang === "ar"
              ? "يُحفظ اختيارك ويُطبَّق من أول عرض للصفحة، دون وميض أو تبديل بعد التحميل."
              : "Your choice is stored and applied from the first render — no flash, no post-load switch."}
          </p>
        </Section>

        <Section
          title={t("term.settings.telegram")}
          action={
            <Tag tone={configured ? "bull" : "muted"}>
              {configured ? (
                <Check className="h-3 w-3" aria-hidden />
              ) : (
                <X className="h-3 w-3" aria-hidden />
              )}
              {configured ? t("term.settings.telegramReady") : t("term.settings.telegramMissing")}
            </Tag>
          }
        >
          <p className="text-xs leading-relaxed text-ink-muted">{telegram?.data.note ?? "—"}</p>
          <button
            type="button"
            onClick={sendTest}
            disabled={!configured || sending}
            className="btn btn-sm mt-3 gap-1.5"
          >
            <Send className="h-3.5 w-3.5" aria-hidden />
            {sent ? t("term.settings.telegramSent") : t("term.settings.telegramTest")}
          </button>
        </Section>

        <Section title={t("term.settings.risk")}>
          <dl className="space-y-2.5">
            <Rule label={t("term.risk")} value={`${DEFAULT_BOT_CONFIG.riskPerTradePct}%`} />
            <Rule label={t("term.rr")} value={`≥ ${DEFAULT_BOT_CONFIG.minRewardRisk}`} />
            <Rule label={t("term.confidence")} value={`≥ ${DEFAULT_BOT_CONFIG.minConfidence}`} />
            <Rule label={t("term.position")} value={`≤ ${DEFAULT_BOT_CONFIG.maxPositions}`} />
            <Rule label="Max / sector" value={`≤ ${DEFAULT_BOT_CONFIG.maxPerSector}`} />
            <Rule label="Max position" value={`${DEFAULT_RISK.maxPositionPct}%`} />
            <Rule label={t("exit.breakeven")} value={`T${DEFAULT_BOT_CONFIG.breakevenAfterTargets}`} />
            <Rule label={t("exit.trailing")} value={`T${DEFAULT_BOT_CONFIG.trailAfterTargets} · ${DEFAULT_BOT_CONFIG.trailAtrMultiple}×ATR`} />
          </dl>
          <p className="mt-4 border-t border-rule-faint pt-3 text-xs leading-relaxed text-ink-faint">
            {t("term.settings.riskNote")}
          </p>
        </Section>

        <Section title={t("term.settings.data")}>
          <dl className="space-y-2.5">
            <Rule label="Candles" value="Binance · OKX · Bybit" />
            <Rule label="Markets" value="CoinGecko" />
            <Rule label="Sentiment" value="alternative.me" />
            <Rule label={t("site.stat.assets")} value={String(UNIVERSE.length)} />
          </dl>
          <p className="mt-4 border-t border-rule-faint pt-3 text-xs leading-relaxed text-ink-faint">
            {lang === "ar"
              ? "كل استجابة تحمل مصدرها وحالتها. حين يتعذّر الوصول إلى كل المنصات تُعرض بيانات تجريبية موسومة بوضوح، ولا يتداول الروبوت عليها."
              : "Every response carries its source and state. When no venue is reachable, clearly labelled demo data is shown — and the bot will not trade on it."}
          </p>
        </Section>

        <Section title={t("term.settings.about")} className="lg:col-span-2">
          <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
            {t("disclaimer.long")}
          </p>
        </Section>
      </div>
    </>
  );
}

function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-rule ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3">
        <h2 className="font-display text-base text-ink">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule-faint pb-2 last:border-0 last:pb-0">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd>
        <Num size="xs" className="text-ink">
          {value}
        </Num>
      </dd>
    </div>
  );
}
