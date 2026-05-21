import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSR enabled: build for server/runtime execution (Cloudflare Workers via OpenNext).
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
