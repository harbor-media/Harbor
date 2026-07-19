import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeClient, createClient, type Db } from "./client.js";

/** Derived from the ASCII bytes of "HARB". Any stable constant works; it must not change. */
export const MIGRATION_LOCK_KEY = 1212961346n;

const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Applies pending migrations under a PostgreSQL advisory lock.
 *
 * Opens its own single connection rather than using the application pool.
 * pg_advisory_lock is session-scoped, so with a pool the lock and unlock could
 * land on different connections and the guard would silently not hold.
 */
export async function runMigrations(url: string, migrationsFolder: string): Promise<void> {
  const { sql: client, db } = createClient(url, { max: 1 });
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await migrate(db, {
        migrationsFolder,
        migrationsTable: MIGRATIONS_TABLE,
        migrationsSchema: "public",
      });
    } finally {
      await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  } finally {
    await closeClient(client);
  }
}

/**
 * True when the migrations table is absent or empty.
 *
 * Must be two statements. PostgreSQL resolves table references at plan time,
 * so a single query referencing the migrations table errors on a fresh
 * database no matter how it is guarded — the existence check has to complete
 * before the table is ever named.
 */
export async function hasPendingMigrations(db: Db): Promise<boolean> {
  const existence = await db.execute<{ present: boolean }>(
    sql`select to_regclass(${`public.${MIGRATIONS_TABLE}`}) is not null as present`,
  );
  if (existence[0]?.present !== true) return true;

  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier(MIGRATIONS_TABLE)}`,
  );
  return rows[0]?.count === "0";
}
