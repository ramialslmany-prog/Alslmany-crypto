export type Lang = "ar" | "en";
export type Dir = "rtl" | "ltr";

/** One area's strings, mirrored across both languages. */
export type Entries = Record<string, string>;
export type Area = { ar: Entries; en: Entries };

export const LANG_COOKIE = "alslmany.lang";
export const DEFAULT_LANG: Lang = "ar";

export function dirOf(lang: Lang): Dir {
  return lang === "ar" ? "rtl" : "ltr";
}

export function normalizeLang(value: string | undefined | null): Lang {
  return value === "en" ? "en" : "ar";
}
