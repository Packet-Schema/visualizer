import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: [
      "tests/integration/**/*.integration.test.ts",
      "tests/integration/**/*.integration.test.tsx",
    ],
    testTimeout: 180000, // 3 minutes for integration tests (includes server startup)
    fileParallelism: false, // prevent port conflicts between test files
    globalSetup: ["tests/integration/global-setup.ts"],
  },
});
