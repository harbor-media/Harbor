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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type HarborApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import { testEnv } from "../../test-helpers.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "../auth/tokens.js";

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

// A different secret from testEnv.HARBOR_SECRET, standing in for the value
// that was in effect when the key was originally stored.
const PREVIOUS_SECRET = "fedcba9876543210fedcba9876543210";

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

  // Store a credential under the OLD secret, then run the app under the
  // current one — exactly the state an operator lands in after rotating
  // HARBOR_SECRET without re-entering the provider key.
  await saveMetadataProviderConfig(db, {
    providerId: "tmdb",
    enabled: true,
    encryptedApiKey: encryptSecret("key-from-before-the-rotation", PREVIOUS_SECRET),
    language: "en-US",
    lastVerifiedAt: new Date(),
  });

  const user = await createUser(db, {
    username: "rotationprobe",
    email: "rotationprobe@example.com",
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

describe("a stored key that no longer decrypts", () => {
  it("tells the operator to re-enter the key instead of failing generically", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=blade%20runner",
      cookies: { [SESSION_COOKIE]: sessionToken },
    });

    // Not a 500: a generic server error would send an operator hunting a
    // fault in Harbor rather than performing the one action that fixes this.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("METADATA_KEY_UNREADABLE");
    expect(res.json().error.message).toMatch(/HARBOR_SECRET/);
  });

  it("does not report the provider as unconfigured", async () => {
    // The row is present and intact; it simply cannot be read under the
    // current secret. Reporting "not configured" would describe the wrong
    // problem and imply a different fix.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=blade%20runner",
      cookies: { [SESSION_COOKIE]: sessionToken },
    });

    expect(res.json().error.code).not.toBe("METADATA_NOT_CONFIGURED");
  });

  it("never echoes the undecryptable stored value", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=blade%20runner",
      cookies: { [SESSION_COOKIE]: sessionToken },
    });

    expect(res.body).not.toContain("key-from-before-the-rotation");
    expect(res.body).not.toContain("v1:");
  });
});
