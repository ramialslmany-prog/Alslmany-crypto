"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { I18nProvider } from "@/lib/i18n/provider";
import type { Lang } from "@/lib/i18n/types";

export function Providers({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  // One client per browser session. Market data goes stale fast, so defaults
  // are tuned short and refetch-on-focus is on — a trader tabbing back should
  // never read a price from ten minutes ago.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            retry: 2,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <I18nProvider initialLang={lang}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}
