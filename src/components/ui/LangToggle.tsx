"use client";

import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/** Switches language live and persists the choice for the next server render. */
export function LangToggle({ className }: { className?: string }) {
  const { t, toggleLang, lang } = useI18n();

  return (
    <button
      type="button"
      onClick={toggleLang}
      className={cn("btn btn-sm gap-1.5", className)}
      aria-label={lang === "ar" ? "Switch to English" : "التبديل إلى العربية"}
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      <span className="font-mono text-2xs tracking-[0.1em]">{t("lang.switch")}</span>
    </button>
  );
}
