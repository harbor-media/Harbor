import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

// E2E_DATABASE_URL is always set by scripts/run-e2e.mjs (the `test:e2e`
// entrypoint), which either starts a disposable PostgreSQL container on its
// own port or uses a caller-provided database. Playwright itself never
// starts the database -- see the comment in scripts/run-e2e.mjs for why
// globalSetup can't be used for that here.
const databaseUrl = process.env["E2E_DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    "E2E_DATABASE_URL is not set. Run the suite via `pnpm test:e2e` (scripts/run-e2e.mjs), " +
      "which provisions it, rather than invoking `playwright test` directly.",
  );
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "list" : "html",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../apps/server/dist/server.js",
    // /health/ready, not /health: boot.ts binds the listener BEFORE migrations
    // run, so /health answers 200 while the schema is still being created.
    // Waiting on it starts the tests mid-migration, /installation/state 503s,
    // and the app renders its error state. This matches the Dockerfile
    // HEALTHCHECK.
    url: `${BASE_URL}/api/v1/health/ready`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      NODE_ENV: "development",
      HARBOR_PORT: String(PORT),
      HARBOR_HOST: "127.0.0.1",
      HARBOR_BASE_URL: BASE_URL,
      HARBOR_SECRET: "e2e-secret-0123456789abcdef0123456789",
      HARBOR_DATA_DIRECTORY: "./.e2e-data",
      HARBOR_LOG_LEVEL: "warn",
      DATABASE_URL: databaseUrl,
    },
  },
});
