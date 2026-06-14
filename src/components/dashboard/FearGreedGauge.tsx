"use client";

import { aiInsights } from "@/lib/mock-data";
import { useFearGreed } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Semicircular Fear & Greed gauge (SVG) — now backed by the real index. */
export function FearGreedGauge() {
  const { t } = useI18n();
  const fg = useFearGreed();
  const value = fg.value;
  const label = t(`fg.${fg.classification}`);
  const isLive = fg.source === "alternative.me";
  const valColor = value >= 55 ? "#00E676" : value <= 45 ? "#FF4D6D" : "#FFD166";
  // Top semicircle: 180° (left) → 270° (top) → 360° (right).
  const angle = 180 + (value / 100) * 180;
  const cx = 100;
  const cy = 100;
  const r = 78;

  return (
    <div className="glass glow-border rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("ov.fearGreed")}</h2>
        <span className="flex items-center gap-1.5 text-[10px] font-medium text-ink-faint">
          <span className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-bull animate-pulse-glow" : "bg-gold")} />
          {t("ov.fgReal")}
        </span>
      </div>

      <div className="mt-2 flex justify-center">
        <svg width="200" height="118" viewBox="0 0 200 118">
          <defs>
            <linearGradient id="fg-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#FF4D6D" />
              <stop offset="50%" stopColor="#FFD166" />
              <stop offset="100%" stopColor="#00E676" />
            </linearGradient>
          </defs>
          {/* track */}
          <path d={arc(cx, cy, r, 180, 360)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="14" strokeLinecap="round" />
          {/* value arc */}
          <path d={arc(cx, cy, r, 180, angle)} fill="none" stroke="url(#fg-grad)" strokeWidth="14" strokeLinecap="round" />
          {/* needle */}
          <g transform={`rotate(${angle} ${cx} ${cy})`}>
            <line x1={cx} y1={cy} x2={cx + r - 10} y2={cy} stroke="#E8ECF6" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={cx} cy={cy} r="6" fill="#E8ECF6" />
          </g>
        </svg>
      </div>

      <div className="-mt-4 text-center">
        <div className="font-display text-4xl font-bold tnum" style={{ color: valColor }}>{value}</div>
        <div className="text-sm font-medium" style={{ color: valColor }}>{label}</div>
      </div>

      {/* AI insight chips */}
      <div className="mt-5 space-y-2 border-t border-white/[0.06] pt-4">
        {aiInsights.map((a) => (
          <div key={a.tag} className="flex items-start gap-2.5">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                a.tone === "bull" ? "bg-bull/12 text-bull" : "bg-gold/12 text-gold"
              )}
            >
              {a.tag}
            </span>
            <span className="text-xs leading-relaxed text-ink-muted">{a.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}
