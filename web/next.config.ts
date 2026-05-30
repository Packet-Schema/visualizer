import type { NextConfig } from "next";
import { randomBytes } from "crypto";

const nextConfig: NextConfig = {
  // SSR enabled: build for server/runtime execution (Cloudflare Workers via OpenNext).
  reactStrictMode: true,
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
  images: { unoptimized: true },
  env: {
    // Unique token generated once per build; appended to OGP image URLs so CDN
    // and SNS caches are busted on each deploy.
    BUILD_ID: randomBytes(8).toString("hex"),
  },
};

export default nextConfig;
