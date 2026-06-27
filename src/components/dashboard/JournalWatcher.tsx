"use client";

/**
 * Headless watcher mounted in the dashboard layout — active on EVERY
 * dashboard page. Every 30s it evaluates the AI trader's open picks against
 * live prices and pushes instant Telegram alerts:
 *   🛑 stop hit (risk realized) · ✅ target hit · ⏰ time exit
 *   ⚠️ early warning when price covers 70% of the way to the stop.
 */
import { useEffect, useRef } from "react";
import { useMarkets } from "@/lib/hooks";
import { evaluateOpen, getJournal, type JTrade, type AdvanceEvent } from "@/lib/ai-journal";
import { autoIssue, maybeSelfReview, fmtPrice, durAr } from "@/lib/trader-engine";

const head = (s: string) => `#${s}/USDT - طويل🟢\n\n`;

/** Final close card (pro signal-channel style). */
const closeMsg = (t: JTrade): string => {
  const ret = t.retPct ?? 0;
  const dur = durAr((t.closedAt ?? Date.now()) - t.issuedAt);
  if (t.status === "tp3")
    return head(t.symbol) + `🎯 إغلاق كامل على الهدف 3 ✅\n\nالربح: +${ret.toFixed(2)}% 📈\nفي: ${dur} ⏰`;
  if (t.status === "tp1") // trailed out after reaching TP2 — profit locked
    return head(t.symbol) + `🔒 أُغلقت بربح مضمون (وقف متحرّك على الهدف 1) ✅\n\nالربح: +${ret.toFixed(2)}% 📈\nفي: ${dur} ⏰`;
  if (t.status === "breakeven")
    return head(t.symbol) + `⚖️ أُغلقت عند نقطة الدخول — بلا ربح أو خسارة\n\nفي: ${dur} ⏰`;
  if (t.status === "expired")
    return head(t.symbol) + `⏰ إغلاق زمني (انتهت مهلة ٧ أيام)\n\nالنتيجة: ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%\nفي: ${dur}`;
  return head(t.symbol) + `🛑 تم ضرب وقف الخسارة\n\nالخسارة: ${ret.toFixed(2)}% 📉\nفي: ${dur} ⏰`;
};

/** Target-reached card while the position stays open (staged take-profit). */
const advanceMsg = (e: AdvanceEvent): string => {
  const dur = durAr(Date.now() - e.trade.issuedAt);
  const top = head(e.trade.symbol) + `تم الوصول إلى الهدف ${e.level} ✅\n\nالربح حتى الآن: +${e.gainPct.toFixed(2)}% 📈\nفي: ${dur} ⏰\n\n`;
  return e.level === 1
    ? top + `🔒 رُفع وقف الخسارة إلى نقطة الدخول — الصفقة الآن بلا مخاطرة.\nمستمرّون نحو الهدف 2 🚀`
    : top + `🔒 رُفع وقف الخسارة إلى الهدف 1 — الربح مضمون.\nمستمرّون نحو الهدف 3 🚀`;
};

export function JournalWatcher() {
  const { coins } = useMarkets();
  const coinsRef = useRef(coins);
  coinsRef.current = coins;

  useEffect(() => {
    const send = (text: string) =>
      fetch("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {});

    // When the 24/7 cloud loop is configured it becomes the single brain — the
    // in-app watcher stays fully silent so trades & Telegram never duplicate.
    let serverActive = false;
    const checkServer = () =>
      fetch("/api/journal").then((r) => r.json()).then((j) => { serverActive = !!j.serverActive; }).catch(() => {});
    checkServer();
    const serverPoll = setInterval(checkServer, 60_000);

    const tick = async () => {
      if (serverActive) return; // cloud loop owns trading + alerts
      const cs = coinsRef.current;
      if (!cs.length) return;
      const lang = (typeof localStorage !== "undefined" && localStorage.getItem("lang")) === "en" ? "en" : "ar";
      const priceOf = (s: string) => cs.find((c) => c.symbol === s)?.price ?? 0;

      // 1) Evaluate open positions → staged targets, exits, risk alerts.
      const { closed, advanced, warned } = evaluateOpen(priceOf);
      for (const e of advanced) send(advanceMsg(e));
      for (const t of closed) send(closeMsg(t));
      for (const t of warned) {
        const p = priceOf(t.symbol);
        send(`#${t.symbol}/USDT - طويل🟢\n\n⚠️ تحذير مخاطرة\nالسعر ${fmtPrice(p)} يقترب من وقف الخسارة ${fmtPrice(t.stop)}\nنقطة الدخول كانت: ${fmtPrice(t.entry)} — راقب الصفقة.`);
      }

      // 2) Auto self-review when positions just closed (lessons → Telegram).
      if (closed.length) await maybeSelfReview(getJournal(), lang);

      // 3) Fully autonomous entries — checked moment-by-moment for fast entry.
      await autoIssue(cs, getJournal(), lang);
    };

    // First pass right after prices load, then every 10s (near real-time).
    const first = setTimeout(tick, 2500);
    const id = setInterval(tick, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      clearInterval(serverPoll);
    };
  }, []);

  return null;
}
