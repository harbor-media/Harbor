import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCatalogFetchedAt, listCatalogTitles, saveCatalogRow } from "./catalog.js";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { catalogEntries, catalogRows } from "./schema.js";
import { upsertTitles, type NormalizedTitle } from "./titles.js";

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
  await db.execute(sql`truncate table titles restart identity cascade`);
  await db.execute(sql`truncate table catalog_rows restart identity cascade`);
});

function title(n: number): NormalizedTitle {
  return {
    type: "movie",
    title: `Title ${String(n)}`,
    originalTitle: null,
    year: 2000 + n,
    overview: null,
    posterPath: `/p${String(n)}.jpg`,
    backdropPath: null,
    externalIds: [{ source: "tmdb", externalId: String(n) }],
  };
}

describe("saveCatalogRow and listCatalogTitles", () => {
  it("returns titles in provider order, not insertion or id order", async () => {
    const order = [17, 3, 20, 1, 12, 8, 15, 2, 19, 6, 11, 4, 14, 9, 18, 5, 13, 10, 16, 7];
    await saveCatalogRow(db, "trending", order.map(title), new Date());

    const rows = await listCatalogTitles(db, "trending");
    expect(rows.map((r) => r.title)).toEqual(order.map((n) => `Title ${String(n)}`));
  });

  // Regression proof (see task-3-report.md Step 6): a query against
  // catalog_entries built on (kind, position) is nearly always answered by
  // that primary-key btree, which returns kind-matching rows pre-sorted by
  // position for free -- so a plain saveCatalogRow/listCatalogTitles round
  // trip cannot expose a missing ORDER BY, because saveCatalogRow always
  // physically inserts rows in position order too. This test writes
  // catalog_entries directly with physical insertion order deliberately
  // reversed from the position column, then forces a sequential scan, to
  // isolate what ORDER BY alone is responsible for.
  it("[ordering-guard proof] does not rely on the titles table's own physical order", async () => {
    // Titles are physically created in DESCENDING title-number order here, so
    // an unordered join naturally probes titles in that same descending
    // order (see plan capture below: titles is the Hash Join's outer/probe
    // side, so the query's output order follows the titles table's scan
    // order, not catalog_entries' insertion order or its primary key). The
    // desired presentation order (position, ascending) is the OPPOSITE of
    // that -- ascending by title number -- so only an explicit ORDER BY on
    // catalog_entries.position can produce the right answer here.
    const n = 30;
    const itemsDescending = Array.from({ length: n }, (_, i) => title(n - i));
    const titleIds = await upsertTitles(db, itemsDescending);

    await db.insert(catalogRows).values({ kind: "trending", fetchedAt: new Date() });
    for (const [i, titleId] of titleIds.entries()) {
      // titleIds[i] is the id for title(n - i); give it position (n - i - 1)
      // so ascending position means ascending title number 1..n.
      await db.insert(catalogEntries).values({ kind: "trending", position: n - i - 1, titleId });
    }

    const rows = await listCatalogTitles(db, "trending");
    const expected = Array.from({ length: n }, (_, i) => `Title ${String(i + 1)}`);
    expect(rows.map((r) => r.title)).toEqual(expected);
  });

  it("drops a title that has left the row rather than accumulating", async () => {
    await saveCatalogRow(db, "trending", [title(1), title(2)], new Date());
    await saveCatalogRow(db, "trending", [title(2)], new Date());

    const rows = await listCatalogTitles(db, "trending");
    expect(rows.map((r) => r.title)).toEqual(["Title 2"]);
  });

  it("keeps rows of different kinds separate", async () => {
    await saveCatalogRow(db, "trending", [title(1)], new Date());
    await saveCatalogRow(db, "popular-movies", [title(2)], new Date());

    expect(await listCatalogTitles(db, "trending")).toHaveLength(1);
    expect(await listCatalogTitles(db, "popular-movies")).toHaveLength(1);
  });

  it("records freshness for a row the provider returned empty", async () => {
    // The whole reason freshness is a separate table. With the stamp on the
    // entries, an empty row would hold no timestamp, read as never-fetched,
    // and re-hit the provider on every single request forever.
    await saveCatalogRow(db, "new-releases", [], new Date());

    expect(await getCatalogFetchedAt(db, "new-releases")).not.toBeNull();
    expect(await listCatalogTitles(db, "new-releases")).toHaveLength(0);
  });

  it("reports no freshness for a kind never fetched", async () => {
    expect(await getCatalogFetchedAt(db, "trending")).toBeNull();
  });

  it("collapses a title the provider listed twice into a single entry", async () => {
    // A provider can return the same title twice on one page. Both items share
    // an external id, so they resolve to one title row -- without a de-dupe the
    // row would carry two entries for it, drawing the poster twice and handing
    // React two children with the same key.
    await saveCatalogRow(db, "trending", [title(1), title(2), title(1)], new Date());

    const rows = await listCatalogTitles(db, "trending");
    // First occurrence wins, so ranking order is preserved: 1 then 2.
    expect(rows.map((r) => r.title)).toEqual(["Title 1", "Title 2"]);
  });

  it("reuses the canonical title row rather than duplicating it", async () => {
    // The same title in two rows must be ONE titles row, or the detail page,
    // search, and every future library entry disagree about its identity.
    await saveCatalogRow(db, "trending", [title(1)], new Date());
    await saveCatalogRow(db, "popular-movies", [title(1)], new Date());

    const trending = await listCatalogTitles(db, "trending");
    const popular = await listCatalogTitles(db, "popular-movies");
    expect(trending[0]?.id).toBe(popular[0]?.id);
  });
});
