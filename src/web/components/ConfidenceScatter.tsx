/**
 * Confidence against realised result.
 *
 * The most useful chart on the site, and the least flattering: if the
 * high-confidence calls do not outperform the low-confidence ones, the
 * confidence number is decoration and the scoring needs rebuilding. A trend
 * line is drawn through the points so the answer is visible, not inferred.
 */
import { num } from "@/web/format";

const W = 720;
const H = 260;
const PAD = { top: 14, bottom: 30, start: 44, end: 12 };

export function ConfidenceScatter({
  points,
}: {
  points: { confidence: number; r: number; symbol: string }[];
}) {
  if (points.length < 3) return null;

  const rValues = points.map((p) => p.r);
  const rMin = Math.min(...rValues, -1.2);
  const rMax = Math.max(...rValues, 1.2);
  const rSpan = rMax - rMin || 1;

  const x = (c: number): number => PAD.start + (Math.max(0, Math.min(100, c)) / 100) * (W - PAD.start - PAD.end);
  const y = (r: number): number => PAD.top + (1 - (r - rMin) / rSpan) * (H - PAD.top - PAD.bottom);

  // Least-squares fit: the line IS the answer to the question the chart asks.
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.confidence, 0) / n;
  const meanY = points.reduce((s, p) => s + p.r, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.confidence - meanX) * (p.r - meanY);
    denominator += (p.confidence - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const fitAt = (c: number): number => slope * c + intercept;

  const working = slope > 0;

  return (
    <div>
      <div className="table-scroll">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`علاقة الثقة بالنتيجة على ${n} صفقة، الميل ${num(slope, 4)}`}
          style={{ display: "block", direction: "ltr" }}
        >
          {/* Breakeven — the line that separates a winner from a loser. */}
          <line x1={PAD.start} x2={W - PAD.end} y1={y(0)} y2={y(0)} stroke="var(--divider)" strokeWidth="1" />
          <text x={PAD.start - 6} y={y(0) + 3.5} fill="var(--text-3)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">0R</text>

          {[rMin, rMax].map((r) => (
            <text key={r} x={PAD.start - 6} y={y(r) + 3.5} fill="var(--text-3)" fontSize="10" textAnchor="end" fontFamily="var(--font-mono)">
              {num(r, 1)}R
            </text>
          ))}

          {[0, 25, 50, 75, 100].map((c) => (
            <g key={c}>
              <line x1={x(c)} x2={x(c)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--divider)" strokeWidth="1" opacity="0.4" />
              <text x={x(c)} y={H - PAD.bottom + 14} fill="var(--text-3)" fontSize="10" textAnchor="middle" fontFamily="var(--font-mono)">{c}</text>
            </g>
          ))}

          <line
            x1={x(0)} y1={y(fitAt(0))} x2={x(100)} y2={y(fitAt(100))}
            stroke={working ? "var(--profit)" : "var(--loss)"} strokeWidth="1.5" strokeDasharray="5 3"
          />

          {points.map((p, i) => (
            <circle
              key={i}
              cx={x(p.confidence)} cy={y(p.r)} r="3.5"
              fill={p.r > 0 ? "var(--profit)" : "var(--loss)"}
              opacity="0.75"
            >
              <title>{p.symbol}: ثقة {num(p.confidence, 0)} → {num(p.r, 2)}R</title>
            </circle>
          ))}

          <text x={W / 2} y={H - 4} fill="var(--text-3)" fontSize="10" textAnchor="middle">الثقة</text>
        </svg>
      </div>

      <div className={`verdict ${working ? "good" : "bad"}`}>
        {working
          ? `الميل موجب (${num(slope, 4)} من R لكل نقطة ثقة) — التوصيات عالية الثقة تتفوّق فعلاً، والرقم يعني شيئاً.`
          : `الميل سالب أو صفر (${num(slope, 4)}) — التوصيات عالية الثقة لا تتفوّق على المنخفضة. ` +
            `الثقة رقم زخرفي بهذه الحالة، وحسابها يحتاج إعادة بناء لا تجميلاً.`}
        {n < 30 && ` العيّنة ${n} صفقة فقط، وهي أصغر من أن تُحسم.`}
      </div>
    </div>
  );
}
