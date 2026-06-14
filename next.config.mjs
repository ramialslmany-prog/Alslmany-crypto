/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Images from external CDNs (coin logos, etc.) can be whitelisted here later.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
