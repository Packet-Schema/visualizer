import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SSR enabled: build for server/runtime execution (Cloudflare Workers via OpenNext).
  reactStrictMode: true,
  images: { unoptimized: true },
  env: {
    // Unique token generated once per build; appended to OGP image URLs so CDN
    // and SNS caches are busted on each deploy.
    BUILD_ID: Math.random().toString(36).slice(2),
  },
};

export default nextConfig;
