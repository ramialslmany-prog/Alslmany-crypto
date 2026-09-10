"use client";

import { cn } from "@/lib/utils";

/**
 * The bot's cumulative R curve.
 *
 * Zero is always drawn, and the vertical scale always includes it, so a
 * drawdown is visible as a drop below the line rather than being cropped away
 * by an axis that starts at the minimum.
 */
export function EquityCurve({
  points,
  className,
  height = 180,
}: {
  points: { at: number; cumulative: number }[];
  className?: string;
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div
        className={cn("flex items-center justify-center border border-rule text-xs text-ink-faint", className)}
        style={{ height }}
      >
        —
      </div>
    );
  }

  const width = 600;
  const values = points.map((p) => p.cumulative);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 8;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`);
  const area = `0,${y(0).toFixed(1)} ${line.join(" ")} ${width},${y(0).toFixed(1)}`;
  const final = values[values.length - 1];
  const positive = final >= 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label={`Cumulative ${final.toFixed(2)}R across ${points.length} closed trades`}
    >
      <polygon
        points={area}
        fill={positive ? "rgba(51,214,159,0.10)" : "rgba(255,77,106,0.10)"}
      />
      {/* The zero line is structural, not decorative. */}
      <line
        x1="0" x2={width} y1={y(0)} y2={y(0)}
        stroke="rgba(239,235,227,0.22)" strokeWidth="1" strokeDasharray="3 3"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={line.join(" ")}
        fill="none"
        stroke={positive ? "#33D69F" : "#FF4D6A"}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
