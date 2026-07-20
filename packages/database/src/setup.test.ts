import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { ensureInstallationRow, getInstallation } from "./installation.js";
import { runMigrations } from "./migrate.js";
import { SetupAlreadyCompleteError, completeSetupWithOwner } from "./setup.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

let container: StartedPostgreSqlContainer;
let client: Awaited<ReturnType<typeof createClient>>["sql"];
let db: Db;

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
  await db.execute(sql`truncate table sessions, users restart identity cascade`);
  await db.execute(sql`update installation set setup_completed_at = null, server_name = null, language = null`);
  await ensureInstallationRow(db);
});

const input = {
  serverName: "Test Harbor",
  language: "en",
  username: "owner",
  email: "owner@example.com",
  passwordHash: "$argon2id$fake",
};

describe("completeSetupWithOwner", () => {
  it("creates the owner and marks setup complete", async () => {
    const owner = await completeSetupWithOwner(db, input);
    expect(owner.role).toBe("owner");
    expect(owner.username).toBe("owner");

    const record = await getInstallation(db);
    expect(record?.setupCompletedAt).toBeInstanceOf(Date);
    expect(record?.serverName).toBe("Test Harbor");
    expect(record?.language).toBe("en");
  });

  it("rejects a second attempt", async () => {
    await completeSetupWithOwner(db, input);
    await expect(
      completeSetupWithOwner(db, { ...input, username: "second" }),
    ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);

    const count = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
    expect(count[0]?.count).toBe("1");
  });

  it("produces exactly one owner under concurrent attempts", async () => {
    const results = await Promise.allSettled([
      completeSetupWithOwner(db, { ...input, username: "racer-a" }),
      completeSetupWithOwner(db, { ...input, username: "racer-b", email: "b@example.com" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const count = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
    expect(count[0]?.count).toBe("1");
  });

  it("ROLLS BACK to a retryable state when user creation fails", async () => {
    // A completed install with no owner would be unrecoverable. Force the
    // insert to fail and assert setup is still incomplete.
    await db.execute(sql`insert into users (username, password_hash, role) values ('taken', 'x', 'user')`);

    await expect(completeSetupWithOwner(db, { ...input, username: "taken" })).rejects.toThrow();

    const record = await getInstallation(db);
    expect(record?.setupCompletedAt).toBeNull();

    // And the install can still be completed afterwards.
    const owner = await completeSetupWithOwner(db, input);
    expect(owner.role).toBe("owner");
  });
});
