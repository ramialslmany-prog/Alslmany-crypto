"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, ArrowUpRight, ArrowDownRight, Circle } from "lucide-react";
import { useServerJournal } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Real activity bell: live count of open server positions + recent closes,
 *  sourced from the 24/7 trade journal (no fake badge). */
export function NotificationBell() {
  const { trades } = useServerJournal();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const openPos = trades.filter((tr) => tr.status === "open");
  const recent = trades.filter((tr) => tr.status !== "open").slice(0, 4);
  const count = openPos.length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("a11y.notifications")}
        className="relative grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-ink-muted transition-colors hover:text-ink"
      >
        <Bell className="h-[18px] w-[18px]" />
        {count > 0 && (
          <span className="absolute -end-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bull px-1 text-[9px] font-bold text-base-950 tnum">{count}</span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 top-12 z-50 w-72 overflow-hidden rounded-2xl border border-white/10 bg-base-900/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <span className="text-sm font-semibold">{t("notif.title")}</span>
            <span className="rounded-full bg-bull/10 px-2 py-0.5 text-[10px] font-bold text-bull tnum">{count} {t("notif.open")}</span>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {openPos.length === 0 && recent.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-ink-faint">{t("notif.empty")}</div>
            )}

            {openPos.map((tr) => (
              <Link key={tr.id} href="/dashboard/tracker" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.03]">
                <Circle className="h-2 w-2 shrink-0 fill-bull text-bull" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{tr.symbol}</div>
                  <div className="text-[11px] text-ink-faint">{t("notif.openPos")}</div>
                </div>
                <span dir="ltr" className="font-mono text-xs text-ink-muted tnum">{formatUsd(tr.entry)}</span>
              </Link>
            ))}

            {recent.length > 0 && (
              <div className="mt-1 px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{t("notif.recent")}</div>
            )}
            {recent.map((tr) => {
              const win = (tr.retPct ?? 0) >= 0;
              return (
                <Link key={tr.id} href="/dashboard/tracker" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/[0.03]">
                  <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-md", win ? "bg-bull/12 text-bull" : "bg-bear/12 text-bear")}>
                    {win ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{tr.symbol}</div>
                    <div className="text-[11px] text-ink-faint">{t(`status.${tr.status}`)}</div>
                  </div>
                  <span dir="ltr" className={cn("font-mono text-xs font-semibold tnum", win ? "text-bull" : "text-bear")}>{win ? "+" : ""}{(tr.retPct ?? 0).toFixed(1)}%</span>
                </Link>
              );
            })}
          </div>

          <Link href="/dashboard/tracker" onClick={() => setOpen(false)} className="block border-t border-white/[0.06] px-4 py-2.5 text-center text-xs font-semibold text-cyan transition-colors hover:bg-white/[0.03]">
            {t("notif.viewAll")}
          </Link>
        </div>
      )}
    </div>
  );
}
