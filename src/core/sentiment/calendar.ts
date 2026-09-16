/**
 * The risk calendar.
 *
 * Known events that make a technically correct trade wrong on timing. Three
 * hard vetoes, exactly as the specification states them:
 *
 *   major economic event within 4 hours  → reject
 *   severe negative news within 6 hours  → reject
 *   token unlock within 72 hours         → reject LONGS
 *
 * NO FREE API PUBLISHES A RELIABLE MACRO CALENDAR, so this reads a file the
 * operator maintains. When that file is absent the stage reports the check as
 * UNAVAILABLE rather than as passed — "I did not look" and "I looked and it
 * was clear" are different answers, and only one of them is safe.
 */
import type { Direction } from "@/core/types";

export type EventKind = "economic" | "token_unlock" | "listing" | "upgrade" | "custom";

export interface CalendarEvent {
  readonly kind: EventKind;
  /** Epoch ms. */
  readonly at: number;
  readonly title: string;
  /** "high" events are the ones that veto. */
  readonly severity: "high" | "medium" | "low";
  /** Empty means market-wide; otherwise the tickers it applies to. */
  readonly assets?: readonly string[];
  /** For unlocks: how much of supply is released. */
  readonly percentOfSupply?: number;
}

export const VETO_WINDOWS = {
  /** A major macro print moves everything; 4 hours covers the run-up. */
  economicHours: 4,
  /** Severe asset news needs time for theالسوق to digest it. */
  severeNewsHours: 6,
  /** Unlocks are known in advance and sell into the days before. */
  unlockHours: 72,
} as const;

export interface CalendarVeto {
  readonly id: "economic_event" | "token_unlock";
  readonly arabic: string;
  readonly event: CalendarEvent;
  readonly hoursAway: number;
}

export interface CalendarCheck {
  /** False when no calendar was supplied — NOT the same as "clear". */
  readonly available: boolean;
  readonly vetoes: readonly CalendarVeto[];
  readonly upcoming: readonly CalendarEvent[];
  readonly arabic: string;
}

export function checkCalendar(
  events: readonly CalendarEvent[] | null,
  asset: { ticker: string },
  direction: Direction,
  now: number,
): CalendarCheck {
  if (events === null) {
    return {
      available: false,
      vetoes: [],
      upcoming: [],
      arabic:
        "تقويم المخاطر غير متاح — لم يُضبط ملف الأحداث. " +
        "«لم أفحص» ليست «فحصتُ ولم أجد شيئاً»، ولذلك تُسجَّل هذه المرحلة ناقصة لا سليمة.",
    };
  }

  const ticker = asset.ticker.toUpperCase();
  const vetoes: CalendarVeto[] = [];
  const upcoming: CalendarEvent[] = [];

  for (const event of events) {
    const hoursAway = (event.at - now) / 3_600_000;
    // Only events ahead of us matter; a print from yesterday is already priced.
    if (hoursAway < 0 || hoursAway > 24 * 14) continue;

    const applies =
      !event.assets || event.assets.length === 0 || event.assets.some((a) => a.toUpperCase() === ticker);
    if (!applies) continue;

    upcoming.push(event);

    if (event.kind === "economic" && event.severity === "high" && hoursAway <= VETO_WINDOWS.economicHours) {
      vetoes.push({
        id: "economic_event",
        event,
        hoursAway,
        arabic:
          `حدث اقتصادي كبير بعد ${hoursAway.toFixed(1)} ساعة («${event.title}»). ` +
          `الحد ${VETO_WINDOWS.economicHours} ساعات. ` +
          "الأحداث الكبرى تُلغي التحليل الفني لساعات، والدخول قبلها مقامرة على عنوان لا على هيكل.",
      });
    }

    if (event.kind === "token_unlock" && hoursAway <= VETO_WINDOWS.unlockHours && direction === "long") {
      vetoes.push({
        id: "token_unlock",
        event,
        hoursAway,
        arabic:
          `فتح توكنات بعد ${hoursAway.toFixed(1)} ساعة` +
          (event.percentOfSupply ? ` بنسبة ${event.percentOfSupply}% من المعروض` : "") +
          `. الحد ${VETO_WINDOWS.unlockHours} ساعة لتوصيات الشراء. ` +
          "المعروض الجديد يُباع قبل وصوله غالباً، فالضغط يبدأ أياماً قبل التاريخ نفسه.",
      });
    }
  }

  upcoming.sort((a, b) => a.at - b.at);

  return {
    available: true,
    vetoes,
    upcoming,
    arabic:
      vetoes.length > 0
        ? `تقويم المخاطر يرفض: ${vetoes.map((v) => v.arabic).join(" · ")}`
        : upcoming.length > 0
          ? `لا أحداث ضمن نوافذ النقض. القادم: ${upcoming.slice(0, 3).map((e) => `${e.title} (بعد ${((e.at - now) / 3_600_000).toFixed(0)} ساعة)`).join("، ")}.`
          : "لا أحداث مجدولة في التقويم خلال أسبوعين.",
  };
}

/**
 * Whether severe negative news is recent enough to veto.
 *
 * Separate from the calendar because news arrives rather than being scheduled,
 * but it applies the same 6-hour window the specification sets.
 */
export function newsVeto(
  worstNegative: { title: string; intensity: number; relevance: number; publishedAt: number } | null,
  now: number,
): { veto: boolean; arabic: string } {
  if (!worstNegative) return { veto: false, arabic: "لا خبر سلبي شديد." };

  const hoursAgo = (now - worstNegative.publishedAt) / 3_600_000;
  const severe = worstNegative.intensity >= 0.6 && worstNegative.relevance >= 0.85;

  if (severe && hoursAgo <= VETO_WINDOWS.severeNewsHours) {
    return {
      veto: true,
      arabic:
        `خبر سلبي شديد عن العملة قبل ${hoursAgo.toFixed(1)} ساعة: «${worstNegative.title.slice(0, 100)}». ` +
        `الحد ${VETO_WINDOWS.severeNewsHours} ساعات. الصفقة تسقط مهما كان التحليل الفني.`,
    };
  }

  if (severe) {
    return {
      veto: false,
      arabic: `خبر سلبي شديد لكنه قبل ${hoursAgo.toFixed(1)} ساعة — خارج نافذة النقض، ويُخفض الثقة فقط.`,
    };
  }
  return { veto: false, arabic: "لا خبر سلبي يبلغ حدّ النقض." };
}
