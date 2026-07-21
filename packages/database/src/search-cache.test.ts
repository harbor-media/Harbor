import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { readSearchCache, SEARCH_CACHE_TTL_MS, writeSearchCache } from "./search-cache.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

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
  await db.execute(sql`truncate table metadata_search_cache`);
});

describe("search cache", () => {
  it("returns null on a miss", async () => {
    expect(await readSearchCache(db, "missing-hash", "en-US", new Date())).toBeNull();
  });

  it("round-trips ids and preserves their order", async () => {
    await writeSearchCache(db, "hash-order", "en-US", [B, A]);
    expect(await readSearchCache(db, "hash-order", "en-US", new Date())).toEqual([B, A]);
  });

  // Language is part of the key: the same words in two languages are two
  // different searches and must not share an entry.
  it("keys entries by language", async () => {
    await writeSearchCache(db, "hash-lang", "en-US", [A]);
    expect(await readSearchCache(db, "hash-lang", "da-DK", new Date())).toBeNull();
  });

  it("treats an entry older than the TTL as a miss", async () => {
    await writeSearchCache(db, "hash-stale", "en-US", [A]);
    const later = new Date(Date.now() + SEARCH_CACHE_TTL_MS + 1000);
    expect(await readSearchCache(db, "hash-stale", "en-US", later)).toBeNull();
  });

  it("replaces an existing entry rather than failing on the primary key", async () => {
    await writeSearchCache(db, "hash-replace", "en-US", [A]);
    await writeSearchCache(db, "hash-replace", "en-US", [B]);
    expect(await readSearchCache(db, "hash-replace", "en-US", new Date())).toEqual([B]);
  });
});
