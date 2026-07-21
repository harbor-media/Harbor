import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { getTitlesByIds, upsertTitles, type NormalizedTitle } from "./titles.js";

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
  // title_external_ids cascades from titles, so truncating titles alone
  // clears both tables.
  await db.execute(sql`truncate table titles restart identity cascade`);
});

function title(overrides: Partial<NormalizedTitle> & { externalId: string }): NormalizedTitle {
  const { externalId, ...rest } = overrides;
  return {
    type: "movie",
    title: "Blade Runner",
    originalTitle: "Blade Runner",
    year: 1982,
    overview: "A blade runner must pursue replicants.",
    posterPath: "/poster.jpg",
    backdropPath: "/backdrop.jpg",
    externalIds: [{ source: "tmdb", externalId }],
    ...rest,
  };
}

describe("upsertTitles", () => {
  it("inserts titles and returns ids in input order", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "78", title: "Blade Runner" }),
      title({ externalId: "335984", title: "Blade Runner 2049", year: 2017 }),
    ]);

    expect(ids).toHaveLength(2);
    const rows = await getTitlesByIds(db, ids);
    expect(rows.map((r) => r.title)).toEqual(["Blade Runner", "Blade Runner 2049"]);
  });

  // Re-searching the same query must update the existing row, not duplicate
  // it. The natural key is (source, external_id), never the display title.
  it("updates an existing title rather than duplicating it", async () => {
    const [first] = await upsertTitles(db, [title({ externalId: "78", overview: "Original." })]);
    const [second] = await upsertTitles(db, [title({ externalId: "78", overview: "Updated." })]);

    expect(second).toBe(first);
    const rows = await getTitlesByIds(db, [first!]);
    expect(rows[0]?.overview).toBe("Updated.");
  });

  // Two distinct films sharing a name must stay distinct.
  it("keeps same-named titles with different external ids separate", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "1001", title: "The Thing", year: 1982 }),
      title({ externalId: "1002", title: "The Thing", year: 2011 }),
    ]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("getTitlesByIds", () => {
  // Relevance ranking lives in the id array. A plain WHERE IN returns rows in
  // whatever order PostgreSQL likes, which would silently scramble results
  // while every other assertion still passed.
  it("returns rows in the order of the requested ids", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "2001", title: "First" }),
      title({ externalId: "2002", title: "Second" }),
      title({ externalId: "2003", title: "Third" }),
    ]);

    const reversed = [...ids].reverse();
    const rows = await getTitlesByIds(db, reversed);
    expect(rows.map((r) => r.title)).toEqual(["Third", "Second", "First"]);
  });

  it("skips ids that no longer exist", async () => {
    const ids = await upsertTitles(db, [title({ externalId: "3001" })]);
    const rows = await getTitlesByIds(db, [
      ...ids,
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(rows).toHaveLength(1);
  });
});
