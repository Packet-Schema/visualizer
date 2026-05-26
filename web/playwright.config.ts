import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:8787",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],

  webServer: process.env.CI
    ? {
        command: "npm run preview:worker:start",
        url: "http://localhost:8787",
        reuseExistingServer: false,
        timeout: 120 * 1000,
      }
    : {
        command: "npm run preview:worker:start",
        url: "http://localhost:8787",
        reuseExistingServer: true,
        timeout: 120 * 1000,
      },
});
