import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "@harbor/crypto";
import {
  closeClient,
  createClient,
  createSession,
  createUser,
  runMigrations,
  saveMetadataProviderConfig,
  type Db,
} from "@harbor/database";
import { createLogger } from "@harbor/logger";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type HarborApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import { testEnv } from "../../test-helpers.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "../auth/tokens.js";

// A configured provider that is always unreachable. This is the condition
// under test: CLAUDE.md requires that readiness must NOT fail because an
// external metadata provider is unavailable. A self-hosted server reporting
// itself unhealthy over a third-party outage would make an orchestrator
// restart a container that is working fine, taking authentication, the
// library, and playback down with it.
vi.mock("./providers/tmdb.js", () => ({
  createTmdbProvider: () => ({
    id: "tmdb",
    validateConfiguration: async () => {
      throw new (await import("./providers/types.js")).MetadataProviderError(
        "unavailable",
        "simulated outage",
      );
    },
    search: async () => {
      throw new (await import("./providers/types.js")).MetadataProviderError(
        "unavailable",
        "simulated outage",
      );
    },
  }),
}));

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let client: Awaited<ReturnType<typeof createClient>>["sql"];
let db: Db;
let app: HarborApp;
let sessionToken: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await runMigrations(container.getConnectionUri(), migrationsFolder);
  const c = createClient(container.getConnectionUri(), { max: 5 });
  client = c.sql;
  db = c.db;

  await saveMetadataProviderConfig(db, {
    providerId: "tmdb",
    enabled: true,
    encryptedApiKey: encryptSecret("unreachable-provider-key", testEnv.HARBOR_SECRET),
    language: "en-US",
    lastVerifiedAt: new Date(),
  });

  // Search requires an authenticated user, so the outage assertion below
  // exercises the provider rather than stopping at the auth guard.
  const user = await createUser(db, {
    username: "readinessprobe",
    email: "readinessprobe@example.com",
    passwordHash: "not-used-in-this-suite",
    role: "user",
  });
  sessionToken = generateSessionToken();
  await createSession(db, {
    userId: user.id,
    tokenHash: hashSessionToken(sessionToken),
    expiresAt: sessionExpiry(),
  });

  const state = createRuntimeState();
  state.databaseReady = true;
  state.migrationsApplied = true;
  state.dataDirectoryWritable = true;

  app = await createApp({
    env: testEnv,
    logger: createLogger({ level: "silent", production: true }),
    db,
    sql: c.sql,
    state,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await closeClient(client);
  await container.stop();
});

describe("readiness under a metadata provider outage", () => {
  it("reports the outage on the search endpoint", async () => {
    // Establishes that the provider really is failing. Without this, the
    // readiness assertion below would pass even if the outage were never
    // actually triggered, which would make the whole test vacuous.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=blade%20runner",
      cookies: { [SESSION_COOKIE]: sessionToken },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("METADATA_PROVIDER_UNAVAILABLE");
  });

  it("stays ready while the metadata provider is unreachable", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
  });

  it("keeps liveness unaffected", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });

    expect(res.statusCode).toBe(200);
  });
});
