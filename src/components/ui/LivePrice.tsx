"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A live-updating number with two cues for "the data is alive":
 *  1. odometer — when `value` changes it tweens from the old to the new figure
 *     (easeOutCubic) instead of snapping.
 *  2. tick-flash — the figure briefly tints green (up) or red (down) then fades.
 * Honors prefers-reduced-motion (snaps, no tween/flash).
 */
export function LivePrice({
  value,
  format,
  className,
  duration = 500,
  flash = true,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  duration?: number;
  flash?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const prev = useRef(value);
  const raf = useRef(0);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    prev.current = to;
    if (from === to || !Number.isFinite(to)) {
      setDisplay(to);
      return;
    }

    if (flash) setDir(to > from ? "up" : "down");
    const clearDir = setTimeout(() => setDir(null), 650);

    if (prefersReducedMotion()) {
      setDisplay(to);
      return () => clearTimeout(clearDir);
    }

    const start = performance.now();
    const animate = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf.current = requestAnimationFrame(animate);
    };
    raf.current = requestAnimationFrame(animate);
    return () => {
      clearTimeout(clearDir);
      cancelAnimationFrame(raf.current);
    };
  }, [value, duration, flash]);

  return (
    <span
      className={cn(
        "tnum transition-colors duration-500 ease-out",
        dir === "up" && "text-bull",
        dir === "down" && "text-bear",
        className
      )}
    >
      {format(display)}
    </span>
  );
}
