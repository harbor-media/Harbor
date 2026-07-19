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

// This suite must run last in this file. It resets the shared container's
// schema to a pre-migration state, which would break every test above that
// assumes a migrated database. Every test above is self-sufficient (it calls
// runMigrations itself rather than relying on this file's execution order),
// but there is no point re-migrating an already-fresh database between them,
// so this destructive suite is kept separate and last regardless.
describe("runMigrations under a genuine fresh-schema race", () => {
  it("applies exactly once across five independent concurrent boots", async () => {
    const trials = 5;

    for (let trial = 0; trial < trials; trial += 1) {
      // Drop and recreate the schema so no tables and no __drizzle_migrations
      // bookkeeping remain: this is what a truly fresh installation looks like,
      // as opposed to a database an earlier test already migrated.
      const reset = createClient(url, { max: 1 });
      try {
        await reset.db.execute(sql`drop schema public cascade`);
        await reset.db.execute(sql`create schema public`);
      } finally {
        await closeClient(reset.sql);
      }

      const check = createClient(url, { max: 1 });
      try {
        expect(
          await hasPendingMigrations(check.db),
          `trial ${trial}: schema reset did not actually produce a pending-migrations state`,
        ).toBe(true);
      } finally {
        await closeClient(check.sql);
      }

      // Two concurrent boots racing against the same fresh schema, exactly as
      // two containers starting simultaneously would.
      const results = await Promise.allSettled([
        runMigrations(url, migrationsFolder),
        runMigrations(url, migrationsFolder),
      ]);
      for (const [index, result] of results.entries()) {
        expect(
          result.status,
          `trial ${trial}: concurrent runMigrations() call ${index} rejected: ${
            result.status === "rejected" ? String(result.reason) : ""
          }`,
        ).toBe("fulfilled");
      }

      const { sql: client, db } = createClient(url, { max: 1 });
      try {
        // postgres.js returns an array directly, NOT { rows: [...] }
        const tables = await db.execute<{ count: string }>(sql`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'public' and table_name = 'installation'
        `);
        expect(tables[0]?.count, `trial ${trial}: installation table count`).toBe("1");

        const constraints = await db.execute<{ count: string }>(sql`
          select count(*)::text as count from information_schema.table_constraints
          where table_name = 'installation' and constraint_name = 'installation_singleton'
        `);
        expect(
          constraints[0]?.count,
          `trial ${trial}: installation_singleton constraint count`,
        ).toBe("1");

        // The real regression signal: if the advisory lock did not hold, two
        // concurrent migrators can both observe "no rows yet" and both insert
        // their bookkeeping row for the same migration.
        const migrations = await db.execute<{ count: string }>(sql`
          select count(*)::text as count from __drizzle_migrations
        `);
        expect(migrations[0]?.count, `trial ${trial}: __drizzle_migrations row count`).toBe("1");
      } finally {
        await closeClient(client);
      }
    }
  });
});
