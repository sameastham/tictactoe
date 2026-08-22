import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Read flow. Runs against a production `next start`
 * server (started fresh per invocation) on a throwaway sqlite DB
 * (.tmp/e2e.db) seeded by `./e2e/global-setup.ts`, with MODEL_PROVIDER and
 * STT_PROVIDER forced to their deterministic fixture implementations — no
 * network calls, no API key, no python/faster-whisper env needed. Single
 * worker: all tests share one DB, so they must run serially, never in
 * parallel — including across projects (see `workers: 1` below), since the
 * desktop project (added for the desktop-layout wave) runs against the SAME
 * webServer/DB the mobile project does.
 */

/** Desktop specs are named `desktop-*.spec.ts` — kept out of the mobile project's run (`testIgnore` below) so nothing double-runs. */
const DESKTOP_SPEC_PATTERN = /desktop-.*\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  // Shared across every project in this run (not per-project) — both
  // projects hit the same `.tmp/e2e.db` through the one `webServer` below,
  // so mobile and desktop specs must still never run concurrently.
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
      testIgnore: DESKTOP_SPEC_PATTERN,
      use: {
        ...devices["Pixel 7"],
        // Fake mic stream + auto-granted mic permission, so the Talk voice
        // recorder (plan §4.3 week 7 — see e2e/talk-voice.spec.ts) can run
        // headless/unattended. Harmless for every other spec: they never
        // touch getUserMedia.
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
    {
      // Desktop-layout wave: a 1440x900 desktop-Chrome project running only
      // `desktop-*.spec.ts` files, against the exact same webServer/DB as
      // the mobile project above. Playwright runs projects in the array
      // order given here, so this always runs after `chromium` within one
      // `npm run e2e` invocation.
      name: "desktop-chromium",
      testMatch: DESKTOP_SPEC_PATTERN,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
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
      // Merges e2e/fixtures/plan-level.json (a tiny fake syllabus level
      // matching fixtures/libro-falso.pdf) into getSyllabusLevels() for this
      // server process only — see src/server/syllabus/config.ts. Harmless
      // for every spec but plan-flow.spec.ts: it only adds one extra level
      // nothing else ever ingests against.
      SYLLABUS_EXTRA_CONFIG_DIR: "e2e/fixtures",
    },
  },
});
