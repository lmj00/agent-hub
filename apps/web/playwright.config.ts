import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4320",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/fixture.mjs",
    url: "http://127.0.0.1:4320/health/live",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
