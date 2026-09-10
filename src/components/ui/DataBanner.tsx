"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import type { Meta } from "@/lib/api";

/**
 * The provenance banner.
 *
 * Synthetic prices must never reach a user who believes they are looking at a
 * live market, so this is deliberately loud and sits above the content rather
 * than beneath it. Stale-but-real data gets a quieter note — it is a caveat,
 * not a falsehood.
 */
export function DataBanner({ meta }: { meta: Meta | undefined }) {
  const { t } = useI18n();
  if (!meta) return null;

  const synthetic = meta.source === "synthetic";
  if (!synthetic && !meta.degraded) return null;

  if (synthetic) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 border-b border-amber/30 bg-amber-wash px-[var(--gutter)] py-3"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
        <p className="text-sm leading-relaxed text-amber-soft">
          <strong className="font-semibold">{t("site.demo.title")}</strong>
          <span className="mx-1.5 text-amber/50">—</span>
          <span className="text-ink-muted">{t("site.demo.body")}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 border-b border-rule px-[var(--gutter)] py-2">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
      <p className="text-xs text-ink-faint">
        <strong className="text-ink-muted">{t("site.stale.title")}</strong>
        <span className="mx-1.5">—</span>
        {t("site.stale.body")}
      </p>
    </div>
  );
}
