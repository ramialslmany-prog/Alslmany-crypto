import type { ReactNode } from "react";

export function Topbar({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      {sub && <span className="sub">{sub}</span>}
      {right && <div className="right">{right}</div>}
    </header>
  );
}
