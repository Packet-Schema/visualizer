// Dedicated vitest config for the CI-EXCLUDED override-invariants diagnostic.
//
// The committed CI run (`npx vitest run`, driven by vitest.config.ts) includes
// ONLY `tests/**/*.test.ts(x)`, so `scripts/override-invariants.ts` never runs
// in CI and cannot redden it. This config exists solely to run the diagnostic
// on demand:
//
//     cd web && npx vitest run --config vitest.diag.config.ts
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
