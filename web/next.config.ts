import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Static export — no image optimisation at runtime.
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
