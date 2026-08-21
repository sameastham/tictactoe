import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Read flow. Runs against a production `next start`
 * server (started fresh per invocation) on a throwaway sqlite DB
 * (.tmp/e2e.db) seeded by `./e2e/global-setup.ts`, with MODEL_PROVIDER and
 * STT_PROVIDER forced to their deterministic fixture implementations — no
 * network calls, no API key, no python/faster-whisper env needed. Single
 * worker: all tests share one DB, so they must run serially, never in
 * parallel.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3111",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: "npm start -- -p 3111",
    port: 3111,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DB_PATH: ".tmp/e2e.db",
      MODEL_PROVIDER: "fixture",
      STT_PROVIDER: "fixture",
    },
  },
});
