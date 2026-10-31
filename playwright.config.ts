import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a production build with seeded synthetic data:
 *   npm run db:migrate && npm run db:seed && npm run build && npm run test:e2e
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    // Signs in the platform admin (password + two-step code) once; platform tests reuse the session.
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
      dependencies: ["setup"],
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    // Messages go to a local mailbox file that tests read; nothing is sent.
    env: { NOTIFICATIONS_TRANSPORT: "log", DEV_MAILBOX_FILE: ".dev-mailbox.jsonl" },
    timeout: 60_000,
  },
});
