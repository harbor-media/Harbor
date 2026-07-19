import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeClient, createClient } from "./client.js";
import { completeSetup, ensureInstallationRow, getInstallation } from "./installation.js";
import { hasPendingMigrations, runMigrations } from "./migrate.js";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  url = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe("runMigrations", () => {
  it("reports pending migrations before running and none after", async () => {
    const { sql, db } = createClient(url, { max: 1 });
    try {
      expect(await hasPendingMigrations(db)).toBe(true);
      await runMigrations(url, migrationsFolder);
      expect(await hasPendingMigrations(db)).toBe(false);
    } finally {
      await closeClient(sql);
    }
  });

  it("applies exactly once when two runners start concurrently", async () => {
    await Promise.all([
      runMigrations(url, migrationsFolder),
      runMigrations(url, migrationsFolder),
    ]);

    const { sql: client, db } = createClient(url, { max: 1 });
    try {
      // postgres.js returns an array directly, NOT { rows: [...] }
      const tables = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from information_schema.tables
        where table_schema = 'public' and table_name = 'installation'
      `);
      expect(tables[0]?.count).toBe("1");

      const constraints = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from information_schema.table_constraints
        where table_name = 'installation' and constraint_name = 'installation_singleton'
      `);
      expect(constraints[0]?.count).toBe("1");
    } finally {
      await closeClient(client);
    }
  });
});

describe("completeSetup", () => {
  it("succeeds once and returns null for the loser of a concurrent race", async () => {
    await runMigrations(url, migrationsFolder);

    const { sql: client, db } = createClient(url, { max: 5 });
    try {
      await ensureInstallationRow(db);

      const [first, second] = await Promise.all([completeSetup(db), completeSetup(db)]);
      const winners = [first, second].filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const record = await getInstallation(db);
      expect(record?.setupCompletedAt).toBeInstanceOf(Date);
    } finally {
      await closeClient(client);
    }
  });

  it("rejects a second installation row at the database level", async () => {
    await runMigrations(url, migrationsFolder);

    const { sql: client, db } = createClient(url, { max: 1 });
    try {
      await ensureInstallationRow(db);
      await expect(
        db.execute(sql`insert into installation (id) values (false)`),
      ).rejects.toThrow();
    } finally {
      await closeClient(client);
    }
  });
});
