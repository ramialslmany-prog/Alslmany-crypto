"use client";

import { useEffect, useState } from "react";
import { Settings, Languages, Send, Bot, Database, Trash2, ShieldCheck, Loader2, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { clearJournal } from "@/lib/ai-journal";
import { clearTracked } from "@/lib/tracker";
import type { TraderSettings } from "@/lib/store";
import { cn } from "@/lib/utils";

export function SettingsView() {
  const { t, lang, toggle } = useI18n();
  const [tg, setTg] = useState<{ configured: boolean; bot?: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [sent, setSent] = useState(false);
  const [cleared, setCleared] = useState<string>("");
  const [settings, setSettings] = useState<TraderSettings | null>(null);
  const [cfg, setCfg] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/telegram").then((r) => r.json()).then(setTg).catch(() => setTg({ configured: false }));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: { configured: boolean; settings: TraderSettings }) => { setSettings(j.settings); setCfg(!!j.configured); })
      .catch(() => setSettings({ maxOpen: 3, minConfidence: 70, entriesEnabled: true }));
  }, []);

  // Optimistically apply a change and persist it to the cloud store the bot reads.
  const patch = async (partial: Partial<TraderSettings>) => {
    if (!settings || !cfg) return;
    const next = { ...settings, ...partial };
    setSettings(next);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const j = (await r.json()) as { ok?: boolean; settings?: TraderSettings };
      if (j.ok && j.settings) { setSettings(j.settings); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    } catch { /* keep optimistic */ }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await fetch("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "✅ Alslmany Crypto — رسالة اختبار من الإعدادات. الاتصال يعمل." }),
      });
      const j = await r.json();
      if (j.ok) { setSent(true); setTimeout(() => setSent(false), 4000); }
    } catch { /* ignore */ }
    setTesting(false);
  };

  const flash = (label: string) => { setCleared(label); setTimeout(() => setCleared(""), 2500); };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet/15 text-violet"><Settings className="h-5 w-5" /></span>
        <div>
          <h1 className="font-display text-xl font-bold">{t("set.title")}</h1>
          <p className="text-sm text-ink-muted">{t("set.sub")}</p>
        </div>
      </div>

      {/* Language */}
      <Card icon={<Languages className="h-4 w-4 text-cyan" />} title={t("set.language")}>
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">{lang === "ar" ? "العربية" : "English"}</span>
          <button onClick={toggle} className="rounded-lg border border-cyan/30 bg-cyan/10 px-4 py-2 text-sm font-bold text-cyan transition-colors hover:bg-cyan/20">
            {lang === "ar" ? "Switch to English" : "التبديل إلى العربية"}
          </button>
        </div>
      </Card>

      {/* Telegram */}
      <Card icon={<Send className="h-4 w-4 text-cyan" />} title={t("set.telegram")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className={cn("h-2 w-2 rounded-full", tg?.configured ? "bg-bull animate-pulse" : "bg-bear")} />
            {tg === null ? t("set.checking") : tg.configured ? (
              <span className="text-ink-muted">{t("at.tgOn")}{tg.bot ? ` · @${tg.bot}` : ""}</span>
            ) : (
              <span className="text-ink-muted">{t("at.tgOff")}</span>
            )}
          </div>
          {tg?.configured && (
            <button onClick={sendTest} disabled={testing} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-1.5 text-xs font-bold text-cyan transition-colors hover:bg-cyan/20 disabled:opacity-50">
              {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sent ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              {sent ? t("set.testSent") : t("set.testSend")}
            </button>
          )}
        </div>
        {!tg?.configured && tg !== null && <p className="mt-2 text-xs text-ink-faint">{t("at.tgHint")}</p>}
      </Card>

      {/* Autonomous trader — configurable; the 24/7 cron reads these live */}
      <Card icon={<Bot className="h-4 w-4 text-violet" />} title={t("set.autoTrader")}>
        {settings === null ? (
          <div className="flex items-center gap-2 text-sm text-ink-faint"><Loader2 className="h-4 w-4 animate-spin" /> {t("set.checking")}</div>
        ) : (
          <div className={cn("space-y-4", !cfg && "opacity-60")}>
            {/* master entry switch */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{t("set.entries")}</div>
                <div className="text-[11px] text-ink-faint">{settings.entriesEnabled ? t("set.on") : t("set.off")}</div>
              </div>
              <button
                onClick={() => patch({ entriesEnabled: !settings.entriesEnabled })}
                disabled={!cfg}
                aria-label={t("set.entries")}
                className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed", settings.entriesEnabled ? "bg-bull/80" : "bg-white/15")}
              >
                <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white transition-all", settings.entriesEnabled ? "start-6" : "start-1")} />
              </button>
            </div>

            {/* max concurrent positions */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="text-ink-muted">{t("set.maxOpen")}</span>
                <span className="font-bold tnum">{settings.maxOpen}</span>
              </div>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => patch({ maxOpen: n })} disabled={!cfg} className={cn("flex-1 rounded-lg border py-1.5 text-xs font-bold tnum transition-colors", settings.maxOpen === n ? "border-cyan/50 bg-cyan/15 text-cyan" : "border-white/10 bg-white/[0.02] text-ink-muted hover:text-ink")}>{n}</button>
                ))}
              </div>
            </div>

            {/* min confidence to enter */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="text-ink-muted">{t("set.minConf")}</span>
                <span className="font-bold tnum">{settings.minConfidence}%</span>
              </div>
              <div className="flex gap-1.5">
                {[60, 65, 70, 75, 80, 85].map((n) => (
                  <button key={n} onClick={() => patch({ minConfidence: n })} disabled={!cfg} className={cn("flex-1 rounded-lg border py-1.5 text-[11px] font-bold tnum transition-colors", settings.minConfidence === n ? "border-cyan/50 bg-cyan/15 text-cyan" : "border-white/10 bg-white/[0.02] text-ink-muted hover:text-ink")}>{n}</button>
                ))}
              </div>
            </div>

            <div className="space-y-2 border-t border-white/[0.06] pt-3 text-sm">
              <Row k={t("set.cadence")} v={t("set.cadenceVal")} />
              <Row k={t("set.alerts")} v={t("set.alertsVal")} />
            </div>

            <p className="text-xs text-ink-faint">{cfg ? t("set.editHint") : t("set.cloudReq")}</p>
            {saved && <p className="flex items-center gap-1.5 text-xs font-medium text-bull"><Check className="h-3.5 w-3.5" /> {t("set.saved")}</p>}
          </div>
        )}
      </Card>

      {/* Data management */}
      <Card icon={<Database className="h-4 w-4 text-gold" />} title={t("set.data")}>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { clearJournal(); flash(t("set.clearedJournal")); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-bear/30 bg-bear/10 px-3 py-2 text-xs font-bold text-bear transition-colors hover:bg-bear/20"
          >
            <Trash2 className="h-3.5 w-3.5" /> {t("set.clearJournal")}
          </button>
          <button
            onClick={() => { clearTracked(); flash(t("set.clearedTracker")); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-bear/30 bg-bear/10 px-3 py-2 text-xs font-bold text-bear transition-colors hover:bg-bear/20"
          >
            <Trash2 className="h-3.5 w-3.5" /> {t("set.clearTracker")}
          </button>
        </div>
        {cleared && <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-bull"><Check className="h-3.5 w-3.5" /> {cleared}</p>}
        <p className="mt-2 text-xs text-ink-faint">{t("set.dataNote")}</p>
      </Card>

      {/* About */}
      <Card icon={<ShieldCheck className="h-4 w-4 text-bull" />} title={t("set.about")}>
        <div className="space-y-2 text-sm">
          <Row k={t("set.appName")} v="Alslmany Crypto" />
          <Row k={t("set.version")} v="1.0" />
          <Row k={t("set.dataSrc")} v="CoinGecko · Binance · OKX · Bybit" />
        </div>
        <p className="mt-2 text-xs text-ink-faint">{t("ms.disclaimer")}</p>
      </Card>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon} {title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.04] pb-2 last:border-0 last:pb-0">
      <span className="text-ink-muted">{k}</span>
      <span className="font-semibold" dir="ltr">{v}</span>
    </div>
  );
}
