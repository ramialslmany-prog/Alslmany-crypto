import { common } from "./common";
import { signals } from "./signals";
import { site } from "./site";
import { terminal } from "./terminal";
import type { Area, Entries, Lang } from "./types";

const AREAS: Area[] = [common, signals, site, terminal];

function merge(lang: Lang): Entries {
  return Object.assign({}, ...AREAS.map((a) => a[lang])) as Entries;
}

export const dictionaries: Record<Lang, Entries> = {
  ar: merge("ar"),
  en: merge("en"),
};

/**
 * Look up a key, interpolating `{placeholders}`.
 * A missing key falls back to Arabic, then to the key itself — so a gap in
 * translation degrades to something readable instead of blank space.
 */
export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = dictionaries[lang][key] ?? dictionaries.ar[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    params[name] !== undefined ? String(params[name]) : m,
  );
}

export * from "./types";
