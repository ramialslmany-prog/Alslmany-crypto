import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "السلماني كريبتو — توصيات وروبوت تداول",
    short_name: "Alslmany",
    description:
      "توصيات عملات رقمية مبنية على تحليل قابل للمراجعة، وروبوت تداول ورقي بسجل أداء شفاف.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#08080A",
    theme_color: "#08080A",
    orientation: "portrait",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
