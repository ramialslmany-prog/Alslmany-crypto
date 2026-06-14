import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Alslmany Crypto — AI Trading Intelligence",
    short_name: "Alslmany",
    description: "AI-powered crypto trading intelligence: live picks, deep analysis, Telegram alerts.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#060816",
    theme_color: "#060816",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
