import { cn } from "@/lib/utils";

/**
 * A minimal price trace. Dependency-free SVG, drawn to fill its box.
 * Direction colour comes from the series itself, so it always agrees with the
 * percentage shown beside it.
 */
export function Sparkline({
  values,
  className,
  width = 120,
  height = 32,
  strokeWidth = 1.25,
}: {
  values: number[];
  className?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}) {
  if (values.length < 2) {
    return <div className={cn("h-8 w-full", className)} aria-hidden />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * step;
    // Inset by the stroke width so the line is never clipped at the extremes.
    const y = height - strokeWidth - ((v - min) / span) * (height - strokeWidth * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const rising = values[values.length - 1] >= values[0];
  const stroke = rising ? "#33D69F" : "#FF4D6A";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-8 w-full overflow-visible", className)}
      role="img"
      aria-label={rising ? "trending up" : "trending down"}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
