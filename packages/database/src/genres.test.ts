import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { getGenresFetchedAt, listCachedGenres, saveGenres } from "./genres.js";

// From packages/database/src, the migrations live one level up in drizzle/.
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
  await db.execute(sql`truncate table genre_cache`);
});

describe("saveGenres and listCachedGenres", () => {
  it("round-trips a type's genre list and stamps freshness", async () => {
    await saveGenres(db, "movie", [{ id: "28", name: "Action" }, { id: "35", name: "Comedy" }], new Date());

    expect(await listCachedGenres(db, "movie")).toEqual([
      { id: "28", name: "Action" },
      { id: "35", name: "Comedy" },
    ]);
    expect(await getGenresFetchedAt(db, "movie")).not.toBeNull();
  });

  it("replaces the list on a second save rather than appending", async () => {
    await saveGenres(db, "movie", [{ id: "28", name: "Action" }], new Date());
    await saveGenres(db, "movie", [{ id: "35", name: "Comedy" }], new Date());

    expect(await listCachedGenres(db, "movie")).toEqual([{ id: "35", name: "Comedy" }]);
  });

  it("keeps types separate", async () => {
    await saveGenres(db, "movie", [{ id: "28", name: "Action" }], new Date());
    await saveGenres(db, "series", [{ id: "10759", name: "Action & Adventure" }], new Date());

    expect(await listCachedGenres(db, "movie")).toHaveLength(1);
    expect(await listCachedGenres(db, "series")).toHaveLength(1);
  });

  it("reports no freshness and an empty list for a type never fetched", async () => {
    expect(await getGenresFetchedAt(db, "series")).toBeNull();
    expect(await listCachedGenres(db, "series")).toEqual([]);
  });
});
