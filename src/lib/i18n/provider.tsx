"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { translate } from "./index";
import { LANG_COOKIE, dirOf, type Dir, type Lang } from "./types";

type Ctx = {
  lang: Lang;
  dir: Dir;
  isRTL: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
};

const I18nContext = createContext<Ctx | null>(null);

/**
 * Language is resolved on the server from a cookie and handed down, so the
 * first paint already carries the right direction — no flash, no mismatch.
 * Switching updates the document attributes live and persists the choice.
 */
export function I18nProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: React.ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    if (typeof document !== "undefined") {
      const dir = dirOf(next);
      document.documentElement.lang = next;
      document.documentElement.dir = dir;
      document.cookie = `${LANG_COOKIE}=${next};path=/;max-age=31536000;samesite=lax`;
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      lang,
      dir: dirOf(lang),
      isRTL: lang === "ar",
      t: (key, params) => translate(lang, key, params),
      setLang,
      toggleLang: () => setLang(lang === "ar" ? "en" : "ar"),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Pick the right side of a bilingual pair without a dictionary round-trip. */
export function useBi() {
  const { lang } = useI18n();
  return (ar: string, en: string) => (lang === "ar" ? ar : en);
}
