"use client";

import { motion } from "framer-motion";
import { useId } from "react";

/**
 * Cinematic SVG area chart with an animated draw-in line, gradient fill,
 * a soft glow, and a pulsing live endpoint. Pure SVG = crisp at any size.
 */
export function AreaChart({
  data,
  width = 760,
  height = 280,
  color = "#00D4FF",
  color2 = "#7C4DFF",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  color2?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const padY = 24;

  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = padY + (height - padY * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });

  // Smooth the line with a simple catmull-rom → bezier
  const line = smoothPath(pts);
  const area = `${line} L${width},${height} L0,${height} Z`;
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="overflow-visible">
      <defs>
        <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="55%" stopColor={color2} stopOpacity={0.1} />
          <stop offset="100%" stopColor={color2} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={color} />
          <stop offset="100%" stopColor={color2} />
        </linearGradient>
        <filter id={`glow-${uid}`} x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* baseline grid */}
      {[0.25, 0.5, 0.75].map((p) => (
        <line key={p} x1={0} x2={width} y1={padY + (height - padY * 2) * p} y2={padY + (height - padY * 2) * p} stroke="rgba(255,255,255,0.05)" strokeDasharray="3 6" />
      ))}

      <motion.path
        d={area}
        fill={`url(#fill-${uid})`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 0.5 }}
      />
      <motion.path
        d={line}
        fill="none"
        stroke={`url(#stroke-${uid})`}
        strokeWidth={2.5}
        strokeLinecap="round"
        filter={`url(#glow-${uid})`}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
      />
      {/* live endpoint */}
      <circle cx={lx} cy={ly} r={9} fill={color2} opacity={0.18}>
        <animate attributeName="r" values="6;13;6" dur="2.2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.3;0;0.3" dur="2.2s" repeatCount="indefinite" />
      </circle>
      <circle cx={lx} cy={ly} r={4} fill="#fff" stroke={color2} strokeWidth={2} />
    </svg>
  );
}

function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}
