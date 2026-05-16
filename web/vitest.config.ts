import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Component and storage tests pick up jsdom via a per-file `@vitest-environment`
    // docblock so the bulk of the suite still runs in plain Node.
    coverage: {
      provider: "v8",
      include: ["lib/formats/**"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      reporter: ["text", "html"],
    },
  },
});
