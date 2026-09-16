/**
 * The equity curve, with buy-and-hold behind it.
 *
 * Both series are NORMALISED TO 100 at the first point, because the question
 * is not "how much money" but "did running this bot beat simply holding
 * Bitcoin". Plotting an equity in dollars against a Bitcoin price in dollars
 * would put two incomparable scales on one axis and answer nothing.
 *
 * Drawn as inline SVG: one scale places every mark, tick and label, colours
 * come from the theme tokens, and the viewBox leaves room for the outermost
 * labels so nothing clips.
 */
import type { EquityPoint } from "@/web/queries";
import { num } from "@/web/format";

const W = 760;
const H = 240;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;
const PAD_START = 8;
const PAD_END = 46; // room for the value labels on the end axis

export function EquityChart({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) return null;

  const first = points[0];
  const baseEquity = first.equity > 0 ? first.equity : 1;
  const firstBtc = points.find((p) => p.btcPrice != null)?.btcPrice ?? null;

  // Normalise both to 100 so the comparison is like for like.
  const equity = points.map((p) => (p.equity / baseEquity) * 100);
  const btc = firstBtc
    ? points.map((p) => (p.btcPrice != null ? (p.btcPrice / firstBtc) * 100 : null))
    : null;

  const values = [...equity, ...(btc ? btc.filter((v): v is number => v != null) : [])];
  const min = Math.min(...values, 100);
  const max = Math.max(...values, 100);
  const span = max - min || 1;
  // A little headroom so the line never touches the frame.
  const lo = min - span * 0.08;
  const hi = max + span * 0.08;

  const x = (i: number): number => PAD_START + (i / (points.length - 1)) * (W - PAD_START - PAD_END);
  const y = (v: number): number => PAD_TOP + (1 - (v - lo) / (hi - lo)) * (H - PAD_TOP - PAD_BOTTOM);

  const path = (series: (number | null)[]): string => {
    let d = "";
    let pen = false;
    series.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const area = (series: number[]): string => {
    const top = path(series);
    if (!top) return "";
    return `${top} L${x(series.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;
  };

  const lastEquity = equity[equity.length - 1];
  const lastBtc = btc ? [...btc].reverse().find((v) => v != null) ?? null : null;
  const beatingBtc = lastBtc != null && lastEquity > lastBtc;

  // Ticks the chart actually reaches, so every label names a real value.
  const ticks = [lo + (hi - lo) * 0.15, 100, hi - (hi - lo) * 0.15]
    .filter((t, i, arr) => arr.findIndex((o) => Math.abs(o - t) < span * 0.05) === i);

  return (
    <div>
      <div className="table-scroll">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`منحنى رأس المال ${num(lastEquity, 1)} مقابل شراء البيتكوين والاحتفاظ ${lastBtc ? num(lastBtc, 1) : "غير متاح"}`}
          style={{ display: "block", direction: "ltr" }}
        >
          {/* Baseline at 100 — the "no change" reference both series start from. */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD_START} x2={W - PAD_END} y1={y(t)} y2={y(t)}
                stroke="var(--divider)" strokeWidth="1"
                strokeDasharray={Math.abs(t - 100) < 0.01 ? "none" : "2 4"}
              />
              <text
                x={W - PAD_END + 6} y={y(t) + 3.5}
                fill="var(--text-3)" fontSize="10" fontFamily="var(--font-mono)"
              >
                {num(t, 0)}
              </text>
            </g>
          ))}

          {/* Buy and hold sits behind, in the neutral informational colour: it
              is a benchmark, not a result, so it must not read as money. */}
          {btc && (
            <path d={path(btc)} fill="none" stroke="var(--info)" strokeWidth="1.25" opacity="0.65" />
          )}

          <path d={area(equity)} fill="var(--accent)" opacity="0.07" />
          <path d={path(equity)} fill="none" stroke="var(--accent)" strokeWidth="1.75" />

          {/* The endpoint, emphasised — it is the number the reader came for. */}
          <circle cx={x(equity.length - 1)} cy={y(lastEquity)} r="3" fill="var(--accent)" />
        </svg>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "10px 12px", borderTop: "1px solid var(--divider)", fontSize: 11 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 2, background: "var(--accent)", display: "inline-block" }} />
          <span style={{ color: "var(--text-2)" }}>البوت</span>
          <span className="num" style={{ color: lastEquity >= 100 ? "var(--profit)" : "var(--loss)" }}>
            {lastEquity >= 100 ? "+" : "−"}{num(Math.abs(lastEquity - 100), 1)}%
          </span>
        </span>

        {lastBtc != null ? (
          <>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 14, height: 2, background: "var(--info)", display: "inline-block", opacity: 0.65 }} />
              <span style={{ color: "var(--text-2)" }}>شراء البيتكوين والاحتفاظ</span>
              <span className="num" style={{ color: lastBtc >= 100 ? "var(--profit)" : "var(--loss)" }}>
                {lastBtc >= 100 ? "+" : "−"}{num(Math.abs(lastBtc - 100), 1)}%
              </span>
            </span>
            <span style={{ color: "var(--text-3)", marginInlineStart: "auto" }}>
              {beatingBtc ? "البوت متقدّم على الاحتفاظ" : "الاحتفاظ متقدّم على البوت"}
            </span>
          </>
        ) : (
          <span style={{ color: "var(--text-3)" }}>
            سعر البيتكوين غير مسجّل مع نقاط المنحنى — لا يمكن المقارنة بالاحتفاظ.
          </span>
        )}
      </div>
    </div>
  );
}
