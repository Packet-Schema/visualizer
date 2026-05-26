import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: [
      "tests/integration/**/*.integration.test.ts",
      "tests/integration/**/*.integration.test.tsx",
    ],
    testTimeout: 120000, // 2 minutes for integration tests
    singleThread: true, // Run serially to avoid port conflicts
  },
});
