"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** EN ⇄ AR switch. Sets <html dir> + persists the choice. */
export function LangToggle({ className }: { className?: string }) {
  const { lang, toggle } = useI18n();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle language"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-xs font-semibold text-ink-muted transition-colors hover:text-ink",
        className
      )}
    >
      <Languages className="h-4 w-4" />
      <span className={cn(lang === "en" && "text-ink")}>EN</span>
      <span className="text-ink-faint">/</span>
      <span className={cn("font-display", lang === "ar" && "text-ink")}>ع</span>
    </button>
  );
}
