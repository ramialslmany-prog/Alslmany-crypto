"use client";

import { cn } from "@/lib/utils";
import { toneOf } from "@/lib/format";

/**
 * Every figure on the site renders through here.
 *
 * Monospaced and tabular so columns of numbers align optically, and isolated
 * LTR so Latin numerals read correctly inside Arabic copy. Direction colour is
 * applied only when the number actually carries a direction — colouring a
 * neutral figure teaches the reader to ignore colour everywhere else.
 */
export function Num({
  children,
  tone,
  className,
  size = "md",
}: {
  children: React.ReactNode;
  /** Pass a signed value to colour by direction, or "none" to stay neutral. */
  tone?: number | null | "none";
  className?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
}) {
  const direction = tone === "none" || tone === undefined ? "flat" : toneOf(tone);
  const sizes = {
    xs: "text-xs",
    sm: "text-sm",
    md: "text-base",
    lg: "text-xl",
    xl: "text-3xl",
  } as const;

  return (
    <span
      className={cn(
        "num tabular-nums",
        sizes[size],
        direction === "up" && "text-bull",
        direction === "down" && "text-bear",
        className,
      )}
    >
      {children}
    </span>
  );
}
