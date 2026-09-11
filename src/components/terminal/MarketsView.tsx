"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useMarkets } from "@/lib/hooks";
import { PageHeader } from "./PageHeader";
import { DataBanner } from "@/components/ui/DataBanner";
import { Empty, Skeleton } from "@/components/ui/Empty";
import { Num } from "@/components/ui/Num";
import { Sparkline } from "@/components/ui/Sparkline";
import { fmtCompact, fmtPct, fmtPrice } from "@/lib/format";
import { isTracked } from "@/lib/market/universe";

/** The market list. Tracked assets link through to their full analysis. */
export function MarketsView() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const { data, isLoading, isError } = useMarkets(150);

  const rows = useMemo(() => {
    const list = data?.data ?? [];
    const q = query.trim().toUpperCase();
    if (!q) return list;
    return list.filter((c) => c.symbol.includes(q) || c.name.toUpperCase().includes(q));
  }, [data, query]);

  return (
    <>
      <DataBanner meta={data?.meta} />
      <PageHeader
        title={t("term.nav.markets")}
        actions={
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute start-2.5 h-3.5 w-3.5 text-ink-faint" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("action.search")}
              aria-label={t("action.search")}
              className="w-44 rounded-md border border-rule-strong bg-ground-900 py-1.5 ps-8 pe-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-amber focus:outline-none sm:w-56"
            />
          </label>
        }
      />

      <div className="p-5 sm:p-7">
        {isLoading ? (
          <div className="space-y-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : isError ? (
          <Empty title={t("state.error")} />
        ) : rows.length === 0 ? (
          <Empty title={t("state.empty")} />
        ) : (
          <div className="overflow-x-auto border border-rule">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule text-start">
                  <Th className="w-10">#</Th>
                  <Th>{t("term.symbol")}</Th>
                  <Th align="end">{t("term.price")}</Th>
                  <Th align="end">{t("term.change24h")}</Th>
                  <Th align="end">{t("term.change7d")}</Th>
                  <Th align="end">{t("term.marketcap")}</Th>
                  <Th align="end">{t("term.volume")}</Th>
                  <Th align="end" className="w-28">7d</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((coin) => {
                  const tracked = isTracked(coin.symbol);
                  return (
                    <tr key={coin.id} className="border-b border-rule-faint last:border-0 hover:bg-ground-900/60">
                      <Td className="text-ink-faint">
                        <Num size="xs">{coin.rank || "—"}</Num>
                      </Td>
                      <Td>
                        {tracked ? (
                          <Link
                            href={`/dashboard/asset/${coin.symbol}`}
                            className="group flex items-baseline gap-2"
                          >
                            <span className="font-medium text-ink group-hover:text-amber-soft">
                              {coin.symbol}
                            </span>
                            <span className="truncate text-xs text-ink-faint">{coin.name}</span>
                          </Link>
                        ) : (
                          <span className="flex items-baseline gap-2">
                            <span className="text-ink-muted">{coin.symbol}</span>
                            <span className="truncate text-xs text-ink-faint">{coin.name}</span>
                          </span>
                        )}
                      </Td>
                      <Td align="end"><Num size="sm">{fmtPrice(coin.price, true)}</Num></Td>
                      <Td align="end"><Num size="sm" tone={coin.changePct24h}>{fmtPct(coin.changePct24h)}</Num></Td>
                      <Td align="end">
                        <Num size="sm" tone={coin.changePct7d || "none"}>
                          {coin.changePct7d ? fmtPct(coin.changePct7d) : "—"}
                        </Num>
                      </Td>
                      <Td align="end">
                        <Num size="xs" className="text-ink-muted">
                          {coin.marketCap ? fmtCompact(coin.marketCap) : "—"}
                        </Num>
                      </Td>
                      <Td align="end">
                        <Num size="xs" className="text-ink-muted">{fmtCompact(coin.volume24h)}</Num>
                      </Td>
                      <Td align="end">
                        {coin.sparkline.length > 1 ? (
                          <Sparkline values={coin.sparkline} className="ms-auto w-24" />
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Th({
  children,
  align = "start",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2.5 font-mono text-2xs font-normal uppercase tracking-[0.12em] text-ink-faint ${
        align === "end" ? "text-end" : "text-start"
      } ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "start",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 ${align === "end" ? "text-end" : "text-start"} ${className ?? ""}`}>
      {children}
    </td>
  );
}
