"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Reveal on scroll.
 *
 * Content is visible by default and only hidden once we know the browser can
 * animate it — so with JavaScript disabled, or before hydration, the page
 * still reads. An entrance animation must never be able to hide content.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  // A callback ref keeps this component polymorphic: parameters are
  // contravariant, so one accepting HTMLElement satisfies every concrete
  // element ref the `as` prop can produce.
  const setRef = useCallback((node: HTMLElement | null) => {
    ref.current = node;
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(true);
      return;
    }
    setArmed(true);

    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Polymorphic through ElementType, which keeps the ref assignable without
  // reaching for an escape hatch on the type system.
  const Component: React.ElementType = Tag;

  return (
    <Component
      ref={setRef}
      className={cn(
        armed && "transition-all duration-700 ease-instrument",
        armed && !shown && "translate-y-4 opacity-0",
        armed && shown && "translate-y-0 opacity-100",
        className,
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </Component>
  );
}
