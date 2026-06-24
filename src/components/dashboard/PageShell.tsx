"use client";

import { usePathname } from "next/navigation";

/** Re-keys on every route change so page content replays its entrance reveal. */
export function PageShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
