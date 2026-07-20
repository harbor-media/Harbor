// Orchestrates the e2e suite so `pnpm test:e2e` is fully self-contained:
// start a disposable PostgreSQL container on its own port, run Playwright
// against it, then tear the container down.
//
// This lives in a plain script rather than Playwright's `globalSetup` /
// `webServer` hooks because, in the pinned Playwright version, the
// `webServer` plugin's own setup task runs *before* the `globalSetup` task
// (confirmed by instrumenting the installed runner). A `webServer.command`
// that needs the database can't rely on `globalSetup` provisioning it first
// -- by the time `globalSetup` would run, `webServer` has already started
// and begun its own connection attempts. Owning the container from a wrapper
// script that runs before Playwright starts at all sidesteps that ordering
// entirely.
import { execFileSync, spawnSync } from "node:child_process";

const CONTAINER_NAME = "harbor-e2e-postgres";
const HOST_PORT = 55433;
const SELF_MANAGED_DATABASE_URL = `postgresql://harbor:harbor@127.0.0.1:${String(HOST_PORT)}/harbor`;

// If the caller (e.g. CI) already provides E2E_DATABASE_URL, assume they own
// that database's lifecycle and skip starting our own container.
const callerProvidedDatabaseUrl = process.env["E2E_DATABASE_URL"];

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function tryRun(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    // best-effort cleanup / removal of a leftover container
  }
}

function waitUntilReady(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER_NAME, "pg_isready", "-U", "harbor", "-d", "harbor"],
        { stdio: "ignore" },
      );
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${CONTAINER_NAME} did not become ready within ${String(deadlineMs)}ms`);
      }
    }
  }
}

let manageContainer = !callerProvidedDatabaseUrl;
let exitCode = 1;

try {
  if (manageContainer) {
    tryRun("docker", ["rm", "-f", CONTAINER_NAME]);
    run("docker", [
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-p",
      `${String(HOST_PORT)}:5432`,
      "-e",
      "POSTGRES_DB=harbor",
      "-e",
      "POSTGRES_USER=harbor",
      "-e",
      "POSTGRES_PASSWORD=harbor",
      "postgres:17-alpine",
    ]);
    waitUntilReady(60_000);
  }

  const result = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      E2E_DATABASE_URL: callerProvidedDatabaseUrl ?? SELF_MANAGED_DATABASE_URL,
    },
  });
  exitCode = result.status ?? 1;
} finally {
  if (manageContainer) {
    tryRun("docker", ["rm", "-f", CONTAINER_NAME]);
  }
}

process.exit(exitCode);
