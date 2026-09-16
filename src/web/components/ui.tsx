/**
 * The shared vocabulary.
 *
 * Deliberately small. Each of these encodes one design rule so that rule
 * cannot be forgotten on a page written later:
 *   Num       — Latin digits isolated left-to-right, tabular
 *   Money     — profit/loss readable WITHOUT colour: sign, then colour
 *   Direction — a word and an arrow, never colour alone
 *   Panel     — a line-bordered region, no shadow
 */
import type { ReactNode } from "react";

/** A number that stays LTR and aligns in a column. */
export function Num({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`num ${className}`}>{children}</span>;
}

/**
 * A financial figure.
 *
 * The sign is part of the text, so the value reads correctly in greyscale,
 * for a colour-blind reader, and in a printout. Colour only reinforces.
 */
export function Money({ value, format }: { value: number | null | undefined; format: (n: number | null | undefined) => string }) {
  const cls = value == null || !Number.isFinite(value) ? "" : value > 0 ? "profit" : value < 0 ? "loss" : "";
  return <span className={`num ${cls}`}>{format(value)}</span>;
}

export function Direction({ direction }: { direction: "long" | "short" }) {
  const long = direction === "long";
  return (
    <span className={`chip ${long ? "chip-long" : "chip-short"}`}>
      <span className="sym">{long ? "▲" : "▼"}</span>
      {long ? "شراء" : "بيع"}
    </span>
  );
}

export function Panel({
  title,
  note,
  actions,
  children,
  className = "",
}: {
  title?: string;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            {title && <span className="section-label">{title}</span>}
            {note && <span style={{ fontSize: 11, color: "var(--text-3)" }}>{note}</span>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {detail && <div className="d">{detail}</div>}
    </div>
  );
}

/**
 * The empty state.
 *
 * A fresh install has no database. Saying "no data" would be true and useless;
 * saying which command produces the data is the difference between a dead page
 * and a working one.
 */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Chip({ kind = "default", children }: { kind?: "default" | "accent" | "info" | "long" | "short"; children: ReactNode }) {
  const cls = kind === "default" ? "" : `chip-${kind}`;
  return <span className={`chip ${cls}`}>{children}</span>;
}
