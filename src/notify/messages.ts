/**
 * What each notification says.
 *
 * Arabic, dense, and complete enough to act on without opening the site —
 * which is the whole point of a phone alert. Numbers keep their Latin digits
 * because that is how an exchange shows them; mixing Arabic-Indic digits into
 * a price the user is about to compare against a chart is a recipe for a
 * misread.
 *
 * Every builder returns the dedupe key too, because the key and the text are
 * two halves of one decision: a message whose key does not match what it is
 * about will be sent repeatedly or suppressed forever.
 */
import { escapeMarkdown } from "@/notify/telegram";
import type { Notification } from "@/notify/policy";
import type { Recommendation } from "@/core/recommendation/types";
import type { CircuitBreaker, Position } from "@/core/execution/types";
import { SETUP_AR } from "@/core/pipeline/types";

const n = (x: number, d = 4): string =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });

const dirAr = (d: "long" | "short"): string => (d === "long" ? "شراء" : "بيع");

/** Bold a heading, escaping the payload but not the markers. */
const heading = (text: string): string => `*${escapeMarkdown(text)}*`;

export function newRecommendation(rec: Recommendation): Notification {
  const targets = rec.targets
    .map((t) => `  هدف ${t.index}: ${n(t.price)} (${Math.round(t.closeFraction * 100)}%)`)
    .join("\n");

  const text = [
    heading(`توصية جديدة · ${rec.symbol} · ${dirAr(rec.direction)}`),
    escapeMarkdown(`النمط: ${SETUP_AR[rec.setup]} · الإطار ${rec.timeframe} · ثقة ${Math.round(rec.confidence)}%`),
    escapeMarkdown(`منطقة الدخول: ${n(rec.entry.low)} – ${n(rec.entry.high)}`),
    escapeMarkdown(`الوقف: ${n(rec.stop)}`),
    escapeMarkdown(targets),
    escapeMarkdown(`العائد للمخاطرة ${rec.riskReward.toFixed(2)} · الحجم ${n(rec.positionSize)} · المخاطرة ${n(rec.riskAmount, 2)}`),
    escapeMarkdown(`سبب الوقف: ${rec.stopBasis}`),
  ].join("\n");

  return {
    kind: "new_recommendation",
    dedupeKey: `new:${rec.id}`,
    text,
    at: rec.generatedAt,
  };
}

export function entryFilled(rec: Recommendation, position: Position, at: number): Notification {
  return {
    kind: "entry_filled",
    dedupeKey: `entry:${rec.id}`,
    at,
    text: [
      heading(`نُفّذ الدخول · ${rec.symbol} · ${dirAr(rec.direction)}`),
      escapeMarkdown(`السعر ${n(position.averageEntry)} · الكمية ${n(position.openQuantity)}`),
      escapeMarkdown(`الوقف ${n(position.currentStop)}`),
    ].join("\n"),
  };
}

export function targetHit(
  rec: Recommendation, target: 1 | 2 | 3, price: number, position: Position, at: number,
): Notification {
  return {
    kind: "target_hit",
    // The target NUMBER is part of the key: without it, target 2 would be
    // suppressed as a duplicate of target 1.
    dedupeKey: `target:${rec.id}:${target}`,
    at,
    text: [
      heading(`الهدف ${target} · ${rec.symbol}`),
      escapeMarkdown(`عند ${n(price)} · المتبقّي ${n(position.openQuantity)}`),
      escapeMarkdown(`المحقّق حتى الآن ${n(position.realizedPnl, 2)} (${position.realizedR.toFixed(2)}R)`),
    ].join("\n"),
  };
}

export function stopHit(rec: Recommendation, position: Position, at: number): Notification {
  const moved = position.stopMovedToBreakeven || position.trailingActive;
  return {
    kind: "stop_hit",
    dedupeKey: `stop:${rec.id}`,
    at,
    text: [
      heading(`${moved ? "خروج بالوقف المتحرّك" : "ضرب الوقف"} · ${rec.symbol}`),
      escapeMarkdown(`السعر ${n(position.currentStop)}`),
      escapeMarkdown(`النتيجة ${n(position.realizedPnl, 2)} (${position.realizedR.toFixed(2)}R) بعد الرسوم والانزلاق`),
    ].join("\n"),
  };
}

export function closed(
  rec: Recommendation, position: Position, kind: "invalidated" | "expired", reason: string, at: number,
): Notification {
  return {
    kind,
    dedupeKey: `${kind}:${rec.id}`,
    at,
    text: [
      heading(`${kind === "expired" ? "انتهت صلاحية التوصية" : "أُبطلت التوصية"} · ${rec.symbol}`),
      escapeMarkdown(reason),
      escapeMarkdown(
        position.openedAt === null
          ? "لم تُنفَّذ أصلاً — لم يصل السعر إلى منطقة الدخول."
          : `النتيجة ${n(position.realizedPnl, 2)} (${position.realizedR.toFixed(2)}R)`,
      ),
    ].join("\n"),
  };
}

export function circuitBreaker(breaker: CircuitBreaker): Notification {
  return {
    kind: "circuit_breaker",
    // Keyed by the trip TIME: the same kind tripping again next week is a new
    // event the user must hear about.
    dedupeKey: `breaker:${breaker.kind}:${breaker.trippedAt}`,
    at: breaker.trippedAt,
    text: [
      heading("قاطع حماية مفعّل — توقّف التداول"),
      escapeMarkdown(breaker.arabic),
      escapeMarkdown(
        breaker.requiresManualReset
          ? "لا يستأنف إلا بتشغيل يدوي."
          : `يستأنف تلقائياً في ${new Date(breaker.resumesAt ?? 0).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      ),
    ].join("\n"),
  };
}

export function sourceFailure(source: string, detail: string, at: number): Notification {
  return {
    kind: "source_failure",
    // Keyed by source and HOUR: a source that is down stays down, and a
    // message every candle would be its own outage.
    dedupeKey: `source:${source}:${Math.floor(at / 3_600_000)}`,
    at,
    text: [
      heading(`مصدر بيانات متعطّل · ${source}`),
      escapeMarkdown(detail),
      escapeMarkdown("المراحل التي تعتمد عليه ستُعلَن «غير متاحة» بخصم ثقة معلن — ولن تُختلق لها قيم."),
    ].join("\n"),
  };
}

export interface DailySummary {
  readonly at: number;
  readonly analyses: number;
  readonly recommendations: number;
  readonly openPositions: number;
  readonly closedToday: number;
  readonly realizedR: number;
  readonly equity: number;
  readonly dayPnlPct: number;
  readonly drawdownPct: number;
}

export function dailyReport(s: DailySummary): Notification {
  const day = new Date(s.at).toISOString().slice(0, 10);
  return {
    kind: "daily_report",
    dedupeKey: `daily:${day}`,
    at: s.at,
    text: [
      heading(`التقرير اليومي · ${day}`),
      escapeMarkdown(`${s.analyses} تحليلاً · ${s.recommendations} توصية · ${s.openPositions} مركز مفتوح`),
      escapeMarkdown(`أُغلقت اليوم ${s.closedToday} صفقة بنتيجة ${s.realizedR.toFixed(2)}R`),
      escapeMarkdown(
        `رأس المال ${n(s.equity, 2)} · اليوم ${s.dayPnlPct >= 0 ? "+" : "−"}${Math.abs(s.dayPnlPct).toFixed(2)}% · ` +
        `التراجع من الذروة ${s.drawdownPct.toFixed(2)}%`,
      ),
    ].join("\n"),
  };
}
