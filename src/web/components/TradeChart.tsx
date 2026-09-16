/**
 * The trade plan drawn on the price it applies to.
 *
 * A candlestick chart with the entry ZONE as a band, the stop as a line, and
 * the three targets as lines. Every level takes its colour from the same
 * semantic tokens the rest of the site uses, and each is labelled with its
 * price so the chart reads without a legend.
 *
 * Reads candles straight from the database, like every other page.
 */
import { query } from "@/web/db";
import { price as fmtPrice } from "@/web/format";
import { tfMillis, type Timeframe } from "@/shared/time";

const W = 900;
const H = 340;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PAD_END = 84; // room for the price labels

interface Bar { openTime: number; open: number; high: number; low: number; close: number }

export function TradeChart({
  symbol, timeframe, direction, entryLow, entryHigh, stop, targets, asOf,
}: {
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  entryLow: number;
  entryHigh: number;
  stop: number;
  targets: number[];
  asOf: number;
}) {
  // A window centred on the decision: enough history to see the structure the
  // levels came from, plus whatever has happened since.
  const step = tfMillis(timeframe);
  const from = asOf - 120 * step;
  const to = asOf + 60 * step;

  const bars = query(
    (db) => db.prepare<[string, string, number, number], Bar>(
      `SELECT open_time AS openTime, open, high, low, close FROM candles
       WHERE symbol = ? AND timeframe = ? AND open_time >= ? AND open_time <= ?
       ORDER BY open_time`,
    ).all(symbol, timeframe, from, to),
    [] as Bar[],
  );

  if (bars.length < 5) {
    return (
      <div className="panel-body">
        <div className="empty">
          لا توجد شموع مخزّنة لهذه الفترة. ابنِ التاريخ أولاً:{" "}
          <code>npm run backfill -- --symbols {symbol} --timeframes {timeframe}</code>
        </div>
      </div>
    );
  }

  const levels = [stop, entryLow, entryHigh, ...targets];
  const lo = Math.min(...bars.map((b) => b.low), ...levels);
  const hi = Math.max(...bars.map((b) => b.high), ...levels);
  const span = hi - lo || 1;
  const yLo = lo - span * 0.04;
  const yHi = hi + span * 0.04;

  const x = (i: number): number => 4 + (i / Math.max(1, bars.length - 1)) * (W - PAD_END - 8);
  const y = (v: number): number => PAD_TOP + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD_TOP - PAD_BOTTOM);
  const barWidth = Math.max(1.2, ((W - PAD_END - 12) / bars.length) * 0.66);

  const decisionIndex = bars.findIndex((b) => b.openTime >= asOf);
  const long = direction === "long";

  const line = (value: number, color: string, label: string, dash?: string) => (
    <g key={`${label}-${value}`}>
      <line
        x1={4} x2={W - PAD_END} y1={y(value)} y2={y(value)}
        stroke={color} strokeWidth="1" strokeDasharray={dash} opacity="0.9"
      />
      <text
        x={W - PAD_END + 6} y={y(value) + 3.5}
        fill={color} fontSize="10" fontFamily="var(--font-mono)"
      >
        {fmtPrice(value)}
      </text>
      <text
        x={W - PAD_END + 6} y={y(value) + 14}
        fill="var(--text-3)" fontSize="9"
      >
        {label}
      </text>
    </g>
  );

  return (
    <div className="table-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`شارت ${symbol} على إطار ${timeframe} مع منطقة الدخول والوقف والأهداف`}
        style={{ display: "block", direction: "ltr" }}
      >
        {/* The entry zone as a band — a range, because that is what it is. */}
        <rect
          x={4} y={y(Math.max(entryLow, entryHigh))}
          width={W - PAD_END - 4}
          height={Math.max(2, Math.abs(y(entryLow) - y(entryHigh)))}
          fill="var(--accent)" opacity="0.10"
        />

        {/* Candles. Green and red here are financial by definition. */}
        {bars.map((b, i) => {
          const up = b.close >= b.open;
          const color = up ? "var(--profit)" : "var(--loss)";
          const bodyTop = y(Math.max(b.open, b.close));
          const bodyHeight = Math.max(1, Math.abs(y(b.open) - y(b.close)));
          return (
            <g key={b.openTime} opacity={decisionIndex >= 0 && i > decisionIndex ? 0.55 : 1}>
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1" />
              <rect x={x(i) - barWidth / 2} y={bodyTop} width={barWidth} height={bodyHeight} fill={color} />
            </g>
          );
        })}

        {/* The moment of decision. Everything to its right is what happened
            AFTER — shown dimmed so hindsight is visibly separate. */}
        {decisionIndex >= 0 && (
          <g>
            <line
              x1={x(decisionIndex)} x2={x(decisionIndex)} y1={PAD_TOP} y2={H - PAD_BOTTOM}
              stroke="var(--text-3)" strokeWidth="1" strokeDasharray="2 3"
            />
            <text x={x(decisionIndex) + 4} y={PAD_TOP + 10} fill="var(--text-3)" fontSize="9">
              لحظة القرار
            </text>
          </g>
        )}

        {line(stop, "var(--loss)", "الوقف")}
        {line(entryHigh, "var(--accent)", "الدخول")}
        {targets.map((t, i) => line(t, "var(--profit)", `هدف ${i + 1}`, "4 3"))}

        {/* Direction marker at the entry, so the plan reads without colour. */}
        <text
          x={8} y={y((entryLow + entryHigh) / 2) - 5}
          fill="var(--accent)" fontSize="10" fontFamily="var(--font-mono)"
        >
          {long ? "▲" : "▼"}
        </text>
      </svg>
    </div>
  );
}
