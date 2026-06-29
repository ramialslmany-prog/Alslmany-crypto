"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/candles";
import { ema } from "@/lib/indicators";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const UP = "#00E676";
const DOWN = "#FF4D6D";
const EMA20 = "#22D3EE";
const EMA50 = "#A78BFA";

/**
 * Self-contained, dependency-free candlestick chart (SVG). Renders real OHLC
 * candles + volume, a right price axis, a time axis, and an interactive
 * crosshair with an O/H/L/C tooltip. Responsive via ResizeObserver so the
 * viewBox matches pixel size 1:1 (crisp text, no stretch).
 */
export function CandleChart({
  candles,
  height = 360,
  className,
}: {
  candles: Candle[];
  height?: number;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = height;
  const padR = 58; // right price axis
  const padB = 20; // bottom time axis
  const topPad = 8;
  const volH = (H - padB) * 0.18;
  const priceH = H - padB - volH - topPad;
  const plotW = Math.max(10, w - padR);

  const n = candles.length;
  const hasData = n >= 2;

  // Scales (guard against empty so hooks order stays stable).
  const lows = hasData ? candles.map((c) => c.l) : [0];
  const highs = hasData ? candles.map((c) => c.h) : [1];
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  const span = hi - lo || hi * 0.02 || 1;
  const yMin = lo - span * 0.06;
  const yMax = hi + span * 0.06;
  const maxVol = hasData ? Math.max(...candles.map((c) => c.v)) || 1 : 1;

  const x = (i: number) => (n ? (i + 0.5) * (plotW / n) : 0);
  const yPrice = (p: number) => topPad + priceH - ((p - yMin) / (yMax - yMin)) * priceH;
  const yVolTop = (v: number) => H - padB - (v / maxVol) * volH;
  const bodyW = Math.max(1, Math.min(14, (plotW / Math.max(n, 1)) * 0.66));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * w;
    if (relX > plotW) return setHover(null);
    const i = Math.floor(relX / (plotW / Math.max(n, 1)));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  if (!hasData) {
    return (
      <div ref={wrapRef} style={{ height: H }} className={cn("grid place-items-center text-sm text-ink-faint", className)}>
        —
      </div>
    );
  }

  const gridN = 4;
  const gridLines = Array.from({ length: gridN + 1 }, (_, k) => yMin + ((yMax - yMin) * k) / gridN);
  const last = candles[n - 1];
  const lastUp = last.c >= last.o;
  const hc = hover != null ? candles[hover] : null;

  // EMA overlays (20 & 50) drawn over the candles.
  const closes = candles.map((c) => c.c);
  const showEma50 = n >= 55;
  const ema20 = ema(closes, 20);
  const ema50 = showEma50 ? ema(closes, 50) : [];
  const linePoints = (arr: number[]) =>
    arr.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${yPrice(v).toFixed(1)}` : "")).filter(Boolean).join(" ");
  const ema20Pts = linePoints(ema20);
  const ema50Pts = showEma50 ? linePoints(ema50) : "";

  // ~5 time labels.
  const tickIdx = Array.from({ length: 5 }, (_, k) => Math.round((k * (n - 1)) / 4));
  const fmtTime = (t: number) => {
    const d = new Date(t);
    const spanMs = candles[n - 1].t - candles[0].t;
    return spanMs > 6 * 864e5
      ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  };

  // Tooltip pixel position (clamped inside the plot).
  const tipX = hover != null ? Math.min(Math.max(x(hover) + 10, 6), plotW - 140) : 0;

  return (
    <div ref={wrapRef} className={cn("relative w-full", className)} style={{ height: H }}>
      <svg
        width={w}
        height={H}
        viewBox={`0 0 ${w} ${H}`}
        className="block touch-none select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* horizontal grid + right price labels */}
        {gridLines.map((p, i) => (
          <g key={i}>
            <line x1={0} y1={yPrice(p)} x2={plotW} y2={yPrice(p)} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
            <text x={w - padR + 6} y={yPrice(p) + 3} fontSize={10} fill="#5b6478" className="tnum">
              {formatUsd(p)}
            </text>
          </g>
        ))}

        {/* time axis labels */}
        {tickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 6} fontSize={9.5} fill="#5b6478" textAnchor="middle" className="tnum">
            {fmtTime(candles[i].t)}
          </text>
        ))}

        {/* volume bars */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          return (
            <rect
              key={`v${i}`}
              x={x(i) - bodyW / 2}
              y={yVolTop(c.v)}
              width={bodyW}
              height={Math.max(0, H - padB - yVolTop(c.v))}
              fill={up ? UP : DOWN}
              opacity={0.18}
            />
          );
        })}

        {/* candles: wick + body */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const color = up ? UP : DOWN;
          const yo = yPrice(c.o);
          const yc = yPrice(c.c);
          const top = Math.min(yo, yc);
          const h = Math.max(1, Math.abs(yc - yo));
          return (
            <g key={`c${i}`}>
              <line x1={x(i)} y1={yPrice(c.h)} x2={x(i)} y2={yPrice(c.l)} stroke={color} strokeWidth={1} />
              <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={h} fill={color} rx={0.5} />
            </g>
          );
        })}

        {/* EMA overlays */}
        {ema20Pts && <polyline points={ema20Pts} fill="none" stroke={EMA20} strokeWidth={1.4} opacity={0.9} />}
        {ema50Pts && <polyline points={ema50Pts} fill="none" stroke={EMA50} strokeWidth={1.4} opacity={0.9} />}

        {/* last price line */}
        <line x1={0} y1={yPrice(last.c)} x2={plotW} y2={yPrice(last.c)} stroke={lastUp ? UP : DOWN} strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
        <rect x={w - padR} y={yPrice(last.c) - 8} width={padR} height={16} fill={lastUp ? UP : DOWN} opacity={0.9} rx={2} />
        <text x={w - padR + 5} y={yPrice(last.c) + 3} fontSize={10} fontWeight={700} fill="#05060f" className="tnum">
          {formatUsd(last.c)}
        </text>

        {/* crosshair */}
        {hc && hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} y1={topPad} x2={x(hover)} y2={H - padB} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={0} y1={yPrice(hc.c)} x2={plotW} y2={yPrice(hc.c)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={yPrice(hc.c)} r={2.5} fill="#E8ECF6" />
          </g>
        )}
      </svg>

      {/* EMA legend */}
      <div className="pointer-events-none absolute start-2 top-2 flex items-center gap-3 text-[10px] font-medium" dir="ltr">
        <span className="flex items-center gap-1" style={{ color: EMA20 }}><span className="inline-block h-0.5 w-3 rounded" style={{ background: EMA20 }} /> EMA 20</span>
        {showEma50 && <span className="flex items-center gap-1" style={{ color: EMA50 }}><span className="inline-block h-0.5 w-3 rounded" style={{ background: EMA50 }} /> EMA 50</span>}
      </div>

      {/* OHLC tooltip overlay (crisp HTML) */}
      {hc && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-white/10 bg-base-950/85 px-2.5 py-1.5 text-[10px] leading-relaxed backdrop-blur-sm"
          style={{ insetInlineStart: tipX }}
          dir="ltr"
        >
          <div className="mb-0.5 text-ink-faint tnum">{new Date(hc.t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono tnum">
            <span className="text-ink-faint">O <span className="text-ink">{formatUsd(hc.o)}</span></span>
            <span className="text-ink-faint">H <span className="text-bull">{formatUsd(hc.h)}</span></span>
            <span className="text-ink-faint">L <span className="text-bear">{formatUsd(hc.l)}</span></span>
            <span className="text-ink-faint">C <span className={hc.c >= hc.o ? "text-bull" : "text-bear"}>{formatUsd(hc.c)}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}
