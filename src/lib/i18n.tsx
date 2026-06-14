"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { dict, type Lang } from "@/lib/translations";

type I18n = {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: (key: string) => string;
  setLang: (l: Lang) => void;
  toggle: () => void;
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Default 'en' on both server and first client render (no hydration mismatch);
  // the saved preference is applied in an effect after mount.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const saved = (typeof window !== "undefined" && (localStorage.getItem("lang") as Lang | null)) || null;
    if (saved === "ar" || saved === "en") setLangState(saved);
  }, []);

  useEffect(() => {
    const dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    try {
      localStorage.setItem("lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const value: I18n = {
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
    t: (key: string) => dict[lang][key] ?? dict.en[key] ?? key,
    setLang: setLangState,
    toggle: () => setLangState((p) => (p === "en" ? "ar" : "en")),
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/** Localized "x ago" relative time. */
export function timeAgo(ts: number, t: (k: string) => string): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t("time.now");
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${t("time.m") === "m ago" ? "m ago" : ` ${t("time.m")}`}`.trim();
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t("time.h") === "h ago" ? "h ago" : ` ${t("time.h")}`}`.trim();
  const d = Math.floor(h / 24);
  return `${d}${t("time.d") === "d ago" ? "d ago" : ` ${t("time.d")}`}`.trim();
}
