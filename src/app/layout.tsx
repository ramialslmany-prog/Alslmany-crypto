import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { LANG_COOKIE, dirOf, normalizeLang } from "@/lib/i18n/types";

export const metadata: Metadata = {
  metadataBase: new URL("https://alslmany-crypto.vercel.app"),
  title: {
    default: "السلماني كريبتو — توصيات العملات الرقمية وروبوت التداول",
    template: "%s · السلماني كريبتو",
  },
  description:
    "توصيات عملات رقمية مبنية على تحليل قابل للمراجعة، وروبوت تداول ذاتي يدير صفقاته بانضباط. تحليل متعدد الأطر، إدارة مخاطر صارمة، وسجل أداء شفاف.",
  keywords: [
    "توصيات العملات الرقمية",
    "تحليل كريبتو",
    "روبوت تداول",
    "crypto recommendations",
    "trading bot",
    "technical analysis",
  ],
  openGraph: {
    type: "website",
    siteName: "Alslmany Crypto",
    title: "السلماني كريبتو — توصيات مبنية على تحليل قابل للمراجعة",
    description:
      "كل توصية مرفقة بأدلتها: الإطار الزمني، البنية السعرية، الزخم، والسيولة — مع نقطة إبطال واضحة.",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#08080A",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = await cookies();
  const lang = normalizeLang(store.get(LANG_COOKIE)?.value);

  return (
    <html lang={lang} dir={dirOf(lang)} className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Amiri — editorial display, Arabic + Latin.
            IBM Plex Sans Arabic — UI voice.
            IBM Plex Mono — every figure on the site. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-ground-950 text-ink antialiased">
        <Providers lang={lang}>{children}</Providers>
      </body>
    </html>
  );
}
