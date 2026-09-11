"use client";

import { useMemo } from "react";
import { closes, ema, last } from "@/lib/analysis/indicators";
import { fmtPrice } from "@/lib/format";
import type { Candle } from "@/lib/market/types";
import { cn } from "@/lib/utils";

/**
 * A candlestick chart drawn directly as SVG.
 *
 * No charting dependency: the token system already defines the colours and
 * hairlines, and a library would arrive with its own opinions about both.
 * Prices are laid out on a linear scale with a small padding so wicks are
 * never clipped at the extremes.
 */

export type ChartLevel = {
  price: number;
  label: string;
  tone: "bull" | "bear" | "amber" | "muted";
};

export function CandleChart({
  candles,
  levels = [],
  height = 340,
  showEma = true,
  className,
}: {
  candles: Candle[];
  levels?: ChartLevel[];
  height?: number;
  showEma?: boolean;
  className?: string;
}) {
  const view = useMemo(() => {
    if (candles.length < 2) return null;

    const width = 1000;
    const padTop = 12;
    const padBottom = 22;
    const axisWidth = 68;
    const plotWidth = width - axisWidth;

    const ema20 = showEma ? ema(closes(candles), 20) : [];
    const ema50 = showEma ? ema(closes(candles), 50) : [];

    // The vertical scale must cover the levels too, or a stop drawn off-canvas
    // silently looks like no stop at all.
    const relevantLevels = levels.map((l) => l.price);
    let min = Math.min(...candles.map((c) => c.l), ...relevantLevels);
    let max = Math.max(...candles.map((c) => c.h), ...relevantLevels);
    const pad = (max - min) * 0.06 || max * 0.01;
    min -= pad;
    max += pad;
    const span = max - min || 1;

    const step = plotWidth / candles.length;
    const bodyWidth = Math.max(1, Math.min(step * 0.62, 14));
    const x = (i: number) => i * step + step / 2;
    const y = (price: number) =>
      padTop + (1 - (price - min) / span) * (height - padTop - padBottom);

    const line = (values: (number | null)[]) =>
      values
        .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
        .filter(Boolean)
        .join(" ");

    // Four gridlines is enough to read a level against without becoming a grid.
    const ticks = Array.from({ length: 5 }, (_, i) => min + (span * i) / 4);

    return {
      width, height, axisWidth, plotWidth, bodyWidth, x, y, ticks,
      ema20: line(ema20), ema50: line(ema50),
      lastPrice: candles[candles.length - 1].c,
      lastEma20: last(ema20), lastEma50: last(ema50),
    };
  }, [candles, levels, height, showEma]);

  if (!view) {
    return (
      <div
        className={cn("flex items-center justify-center border border-rule text-xs text-ink-faint", className)}
        style={{ height }}
      >
        —
      </div>
    );
  }

  const toneColour = {
    bull: "#33D69F",
    bear: "#FF4D6A",
    amber: "#E8A33D",
    muted: "rgba(239,235,227,0.35)",
  };

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <svg
        viewBox={`0 0 ${view.width} ${height}`}
        className="w-full min-w-[560px]"
        style={{ height }}
        role="img"
        aria-label={`Candlestick chart, ${candles.length} bars, last ${fmtPrice(view.lastPrice)}`}
      >
        {/* Gridlines and the price axis */}
        {view.ticks.map((price) => (
          <g key={price}>
            <line
              x1={0} x2={view.plotWidth} y1={view.y(price)} y2={view.y(price)}
              stroke="rgba(239,235,227,0.055)" strokeWidth="1"
            />
            <text
              x={view.plotWidth + 8} y={view.y(price) + 3.5}
              className="fill-ink-faint font-mono" fontSize="10"
            >
              {fmtPrice(price)}
            </text>
          </g>
        ))}

        {/* Candles */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const colour = up ? "#33D69F" : "#FF4D6A";
          const top = view.y(Math.max(c.o, c.c));
          const bottom = view.y(Math.min(c.o, c.c));
          return (
            <g key={c.t}>
              <line
                x1={view.x(i)} x2={view.x(i)} y1={view.y(c.h)} y2={view.y(c.l)}
                stroke={colour} strokeWidth="1" opacity="0.75"
              />
              <rect
                x={view.x(i) - view.bodyWidth / 2}
                y={top}
                width={view.bodyWidth}
                // A doji has zero body height, which would render as nothing.
                height={Math.max(bottom - top, 1)}
                fill={colour}
                opacity={up ? 0.85 : 0.9}
              />
            </g>
          );
        })}

        {/* Moving averages */}
        {showEma && view.ema20 && (
          <polyline points={view.ema20} fill="none" stroke="#E8A33D" strokeWidth="1.25" opacity="0.85" />
        )}
        {showEma && view.ema50 && (
          <polyline points={view.ema50} fill="none" stroke="rgba(239,235,227,0.4)" strokeWidth="1.25" />
        )}

        {/* Plan levels */}
        {levels.map((level) => (
          <g key={`${level.label}-${level.price}`}>
            <line
              x1={0} x2={view.plotWidth}
              y1={view.y(level.price)} y2={view.y(level.price)}
              stroke={toneColour[level.tone]} strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
            />
            <text
              x={6} y={view.y(level.price) - 4}
              fill={toneColour[level.tone]} className="font-mono" fontSize="9"
            >
              {level.label}
            </text>
          </g>
        ))}
      </svg>

      {showEma && (
        <div className="mt-2 flex flex-wrap gap-4 px-1">
          <Legend colour="#E8A33D" label="EMA 20" value={view.lastEma20} />
          <Legend colour="rgba(239,235,227,0.5)" label="EMA 50" value={view.lastEma50} />
        </div>
      )}
    </div>
  );
}

function Legend({ colour, label, value }: { colour: string; label: string; value: number | null }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-2xs text-ink-faint">
      <span className="inline-block h-px w-4" style={{ backgroundColor: colour }} aria-hidden />
      {label}
      {value !== null && <span className="text-ink-muted">{fmtPrice(value)}</span>}
    </span>
  );
}
