import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // The API is live market data, not content worth indexing.
      disallow: ["/api/"],
    },
  };
}
