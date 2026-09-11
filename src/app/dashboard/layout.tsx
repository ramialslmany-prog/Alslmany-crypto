import type { Metadata } from "next";
import { TerminalShell } from "@/components/terminal/TerminalShell";

export const metadata: Metadata = {
  title: { default: "المنصة", template: "%s · المنصة" },
  // The terminal is live market data behind an interface; there is nothing
  // here worth indexing, and plenty worth not indexing.
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <TerminalShell>{children}</TerminalShell>;
}
