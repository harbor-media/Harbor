import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

// The suite must never call the real TMDB: that would make it fail on a
// third party's outage, require a real credential in CI, and load someone
// else's servers on every run. Harbor is pointed at a local fixture instead.
const TMDB_FIXTURE_PORT = 3101;
const TMDB_FIXTURE_URL = `http://127.0.0.1:${String(TMDB_FIXTURE_PORT)}`;

// The image CDN is a SEPARATE host from the metadata API, so it needs its own
// fixture and its own override. Reusing the metadata one would send image
// requests to the API fixture and fail confusingly.
const IMAGE_FIXTURE_PORT = 3102;
const IMAGE_FIXTURE_URL = `http://127.0.0.1:${String(IMAGE_FIXTURE_PORT)}`;

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
  // The suite shares one disposable, stateful database across every spec
  // file (setup-and-login.spec.ts creates the owner; later files sign in as
  // that same owner and depend on invitations/users created by earlier
  // tests). `fullyParallel: false` only serializes tests *within* a file --
  // Playwright still schedules separate files onto separate workers by
  // default, which interleaves them and breaks that shared-state ordering.
  // Pin to a single worker so the whole suite runs as one serial sequence,
  // file order matching alphabetical `testDir` discovery.
  //
  // Because that ordering is load-bearing rather than incidental, spec files
  // carry explicit numeric prefixes (01-, 02-, 03-). Without them a new spec
  // silently sorts wherever its name happens to fall -- a metadata spec added
  // as `metadata.spec.ts` ran before `setup-and-login.spec.ts` and failed on a
  // missing owner account, with nothing in the failure pointing at ordering.
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "list" : "html",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ./scripts/tmdb-fixture.mjs",
      url: `${TMDB_FIXTURE_URL}/authentication`,
      timeout: 30_000,
      reuseExistingServer: false,
      // The fixture answers 401 without a bearer token, which is exactly what
      // Playwright's readiness probe sends. Treat that as "up".
      ignoreHTTPSErrors: true,
      env: { TMDB_FIXTURE_PORT: String(TMDB_FIXTURE_PORT) },
    },
    {
      command: "node ./scripts/image-fixture.mjs",
      url: `${IMAGE_FIXTURE_URL}/count`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { IMAGE_FIXTURE_PORT: String(IMAGE_FIXTURE_PORT) },
    },
    {
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
      HARBOR_TMDB_BASE_URL: TMDB_FIXTURE_URL,
      HARBOR_TMDB_IMAGE_BASE_URL: IMAGE_FIXTURE_URL,
    },
    },
  ],
});
