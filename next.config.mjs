/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module: it must stay external to the server
  // bundle or the .node binary cannot be resolved at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
