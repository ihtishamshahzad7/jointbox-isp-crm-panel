import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * WHY THESE TESTS EXIST
 * The suite already covers the money path well at the unit level (313 backend
 * tests). What it has never covered is whether a person can actually get
 * through the front door: a broken login, a theme that flashes white, or a
 * focus ring that disappears are all invisible to Jest and immediately
 * obvious to a user.
 *
 * NOT RUN IN THE MAIN CI JOB, deliberately. These need the Next server and a
 * reachable backend; wiring that into the existing pipeline before it is
 * green would repeat the mistake made with the lint gate, which was set to
 * blocking against 1,300 pre-existing errors and would have gone red on run
 * one. Run locally with `npx playwright test`, and promote to CI once the
 * backend is containerised there.
 */
export default defineConfig({
  testDir: "./e2e",
  // Every assertion gets a generous window: these run against a real server,
  // and a flaky timeout teaches people to ignore the suite.
  expect: { timeout: 8_000 },
  timeout: 45_000,
  fullyParallel: true,

  // No accidental `.only` reaching CI, and retries ONLY there — a test that
  // needs a retry on a developer's machine is a test that should be fixed.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,

  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    // Artefacts only on failure. Recording everything makes the run slow and
    // the output unreadable, so nobody looks at either.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // A phone profile is not optional for this product: field staff activate
    // customers from a handset, and the panel has a dedicated mobile shell.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  /**
   * Starts the app if it is not already running. `reuseExistingServer` off in
   * CI so a stale process can never make a run pass against old code.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm run start",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
