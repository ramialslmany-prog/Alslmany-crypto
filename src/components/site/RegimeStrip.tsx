"use client";

import { Activity } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useRecommendations, useSentiment } from "@/lib/hooks";
import { Num } from "@/components/ui/Num";
import { Tag } from "@/components/ui/Tag";
import { Skeleton } from "@/components/ui/Empty";
import { fmtPctPlain } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The market regime, stated before any individual call.
 *
 * Placed at the very top of the page on purpose: the same setup means
 * different things in different tides, and a reader who scrolls straight to a
 * recommendation without knowing the regime is reading it out of context.
 */
export function RegimeStrip({ className }: { className?: string }) {
  const { t } = useI18n();
  const { data, isLoading } = useRecommendations();
  const { data: sentiment } = useSentiment();

  if (isLoading) {
    return (
      <div className={cn("flex gap-6 border-b border-rule px-[var(--gutter)] py-3", className)}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
    );
  }

  const market = data?.data.market;
  if (!market) return null;

  const tone =
    market.label === "bull" ? "bull" : market.label === "bear" ? "bear" : "amber";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-rule px-[var(--gutter)] py-3",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <Activity className="h-3.5 w-3.5 text-amber" aria-hidden />
        <Tag tone={tone} dot>
          {t(`regime.${market.label}`)}
        </Tag>
      </div>

      <Stat label={t("term.score")}>
        <Num size="sm" tone={market.score}>
          {market.score > 0 ? "+" : ""}
          {market.score}
        </Num>
      </Stat>

      {market.breadth !== null && (
        <Stat label={t("term.breadth")}>
          <Num size="sm" tone={market.breadth - 50}>
            {fmtPctPlain(market.breadth, 0)}
          </Num>
        </Stat>
      )}

      {sentiment?.data && (
        <Stat label={t("term.sentiment")}>
          <Num size="sm" tone={sentiment.data.value - 50}>
            {sentiment.data.value}
          </Num>
        </Stat>
      )}

      <Stat label={t("term.riskBudget")}>
        <Num size="sm" tone={market.riskBudget - 0.7}>
          {Math.round(market.riskBudget * 100)}%
        </Num>
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}
