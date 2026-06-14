"use client";

import { useState } from "react";
import { colorOf } from "@/lib/coin-meta";
import { cn } from "@/lib/utils";

/**
 * Coin avatar: shows the real logo when available, and falls back to a
 * colored monogram (deterministic hue) if the image is missing or fails.
 */
export function CoinIcon({
  symbol,
  image,
  size = 28,
  className,
}: {
  symbol: string;
  image?: string;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const color = colorOf(symbol);
  const px = `${size}px`;

  if (image && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt={symbol}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn("rounded-full bg-white/5 object-cover", className)}
        style={{ width: px, height: px }}
      />
    );
  }

  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full font-bold", className)}
      style={{ width: px, height: px, background: `${color}22`, color, fontSize: size * 0.4 }}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}
