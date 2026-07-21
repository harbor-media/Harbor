import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as HarborDatabase from "@harbor/database";
import { API_PREFIX } from "@harbor/shared";
import { createLogger } from "@harbor/logger";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type HarborApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import { testEnv } from "../../test-helpers.js";
import { SESSION_COOKIE } from "../auth/cookies.js";

// Stubs network validation so PUT succeeds without a real TMDB call. This is
// the one legitimate use of a provider stub in this suite: everything
// downstream of it (encryption, storage, the response body, the log) is real.
vi.mock("./providers/tmdb.js", () => ({
  createTmdbProvider: () => ({
    id: "tmdb",
    validateConfiguration: async () => undefined,
    search: async () => [],
  }),
}));

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash, getMetadataProviderConfig, createClient, closeClient, runMigrations } =
  await import("@harbor/database");

const SECRET_KEY = "tmdb-secret-key-do-not-leak-9x7q";
const adminToken = "admin-token";

const ADMIN_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "administrator",
  email: "administrator@example.com",
  role: "administrator" as const,
  passwordHash: "x",
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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
let db: HarborDatabase.Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  await runMigrations(container.getConnectionUri(), migrationsFolder);
  const c = createClient(container.getConnectionUri(), { max: 5 });
  client = c.sql;
  db = c.db;
}, 120_000);

afterAll(async () => {
  await closeClient(client);
  await container.stop();
});

beforeEach(async () => {
  await client`truncate table metadata_provider_config restart identity cascade`;
  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: ADMIN_USER.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user: ADMIN_USER,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Builds a real app against the real (Testcontainers) database, with a
 *  logger that captures every emitted line rather than writing to stdout --
 *  following the pattern in ../../request-log-redaction.test.ts. */
async function buildApp(lines: string[]): Promise<HarborApp> {
  const state = createRuntimeState();
  state.databaseReady = true;
  state.migrationsApplied = true;
  state.dataDirectoryWritable = true;
  return createApp({
    env: testEnv,
    logger: createLogger(
      { level: "info", production: true },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ),
    db,
    sql: client,
    state,
  });
}

async function putConfig(app: HarborApp, apiKey: string) {
  return app.inject({
    method: "PUT",
    url: `${API_PREFIX}/admin/metadata/config`,
    cookies: { [SESSION_COOKIE]: adminToken },
    headers: { origin: "http://localhost:3000" },
    payload: { apiKey, language: "en-US", enabled: true },
  });
}

describe("provider key secrecy", () => {
  // Configure a key through the real route, then read the config back and
  // assert the response cannot be used to recover it -- not in full, and not
  // as a masked fragment.
  it("never returns the api key from the config endpoint", async () => {
    const lines: string[] = [];
    const app = await buildApp(lines);

    const putRes = await putConfig(app, SECRET_KEY);
    expect(putRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/admin/metadata/config`,
      cookies: { [SESSION_COOKIE]: adminToken },
    });

    const raw = res.body;
    expect(raw).not.toContain(SECRET_KEY);
    expect(raw).not.toContain(SECRET_KEY.slice(-4));
    expect(res.json().configured).toBe(true);

    await app.close();
  });

  it("never writes the api key to the log", async () => {
    const lines: string[] = [];
    const app = await buildApp(lines);

    const putRes = await putConfig(app, SECRET_KEY);
    expect(putRes.statusCode).toBe(200);
    expect(lines.join("\n")).not.toContain(SECRET_KEY);

    await app.close();
  });

  it("stores the key encrypted rather than in plaintext", async () => {
    const lines: string[] = [];
    const app = await buildApp(lines);

    const putRes = await putConfig(app, SECRET_KEY);
    expect(putRes.statusCode).toBe(200);

    const row = await getMetadataProviderConfig(db, "tmdb");
    expect(row?.encryptedApiKey).not.toContain(SECRET_KEY);
    expect(row?.encryptedApiKey?.startsWith("v1:")).toBe(true);

    await app.close();
  });
});
