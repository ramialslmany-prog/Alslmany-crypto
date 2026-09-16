/**
 * The app shell.
 *
 * Arabic, right-to-left, dark. Fonts come from Google via `next/font`, which
 * self-hosts them at build time — no runtime request to a third party, and no
 * flash of a fallback face.
 */
import type { Metadata, Viewport } from "next";
import { Readex_Pro, IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from "next/font/google";
import { Sidebar } from "@/web/components/Sidebar";
import "./globals.css";

const display = Readex_Pro({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display-loaded",
  display: "swap",
});

const body = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body-loaded",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: "طاولة السلماني",
  description: "تحليل سوق العملات الرقمية عبر ثماني مراحل إلزامية، وتنفيذ ورقي بنتائج معروضة كاملة.",
};

export const viewport: Viewport = {
  themeColor: "#0B1117",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Sidebar />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
