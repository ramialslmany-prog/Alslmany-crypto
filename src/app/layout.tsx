import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Alslmany Crypto — AI Trading Intelligence",
    template: "%s · Alslmany Crypto",
  },
  description:
    "AI-powered crypto trading intelligence: live recommendations, deep coin analysis, multi-exchange price validation and Telegram alerts.",
  keywords: ["crypto", "AI trading", "smart money", "trading signals", "Alslmany"],
  authors: [{ name: "Alslmany Crypto" }],
  openGraph: {
    title: "Alslmany Crypto — AI Trading Intelligence",
    description: "AI-powered crypto trading intelligence platform.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#060816",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://api.fontshare.com" />
        {/* Satoshi — characterful display face (Fontshare) */}
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap"
          rel="stylesheet"
        />
        {/* Inter (UI) + JetBrains Mono (figures) + IBM Plex Sans Arabic (RTL) */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased selection:bg-cyan/30">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
