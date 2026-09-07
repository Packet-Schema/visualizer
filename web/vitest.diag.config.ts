// Dedicated vitest config for the override-invariants harness.
//
// The main run (`npx vitest run`, driven by vitest.config.ts) includes ONLY
// `tests/**/*.test.ts(x)`, so `scripts/override-invariants.ts` needs its own
// config. It is NOT excluded from CI: the `invariants` job in
// .github/workflows/test.yml runs it on every push and PR via
//
//     cd web && npm run test:diag
//
// It reuses the SAME resolver settings (the `@` alias and the `server-only`
// no-op stub) as vitest.config.ts so the harness mirrors the app's real module
// resolution exactly.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["scripts/override-invariants.ts"],
    testTimeout: 600000,
  },
});
