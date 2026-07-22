# Harbor Phase 3c-2b — Home Catalog Rows and App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Harbor's placeholder `/home` card with a Stremio-style home screen — a featured hero and four provider-backed catalog rows — reached through a persistent app shell.

**Architecture:** The metadata provider gains a capability list plus one `getCatalog(kind)` method. Rows are cached in PostgreSQL as two tables — `catalog_rows` for freshness, `catalog_entries` for ordered membership — behind a 6-hour TTL with the same cache-on-read and degraded-stale semantics as title detail. One REST endpoint per row so a failing row cannot blank the others. The web app gains a layout route with persistent top-bar navigation.

**Tech Stack:** TypeScript 6.0.3, Fastify 5.10.0, Drizzle 0.45.2, Zod 4.4.3, React 19.2.7, shadcn on the React Aria base, TanStack Query, Vitest 4.1.10, Playwright 1.61.1.

## Global Constraints

- **Never** add `Co-Authored-By` trailers or any AI attribution to a commit message or PR body.
- `packages/*` and `apps/server` use `moduleResolution: nodenext` — every relative import needs an explicit `.js` extension. `apps/web` uses `bundler` — imports are extensionless.
- Strict TypeScript. No unjustified `any`. Runtime validation at every external boundary.
- Pin dependency versions exactly — no carets.
- Never pipe a verification command through `tail`/`grep` when its exit code matters; a pipe replaces the exit status. Use `cmd >/dev/null && echo OK`.
- Every guard added must have a load-bearing test: break the guard, watch a specific test fail, restore it.
- Migrations are generated with `pnpm --filter @harbor/database exec drizzle-kit generate`, never hand-written.
- Achromatic palette only. Colour is semantic (error/success/warning/info), never decorative.
- Run `pnpm --filter @harbor/database build` after changing `packages/database`, or `apps/server` will compile against a stale `dist`.

---

### Task 1: Shared catalog DTOs

**Files:**
- Modify: `packages/shared/src/index.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `CATALOG_KINDS`, `CatalogKind`, `TitleCard`, `CatalogRowResponse`.

- [ ] **Step 1: Append the DTOs**

```ts
/**
 * The catalog rows Harbor knows how to render. Exported as a const tuple so
 * the web client can iterate every kind without asking the server which are
 * available first -- a capability round-trip would put a waterfall in front
 * of the home screen's four parallel row requests.
 */
export const CATALOG_KINDS = [
  "trending",
  "popular-movies",
  "popular-series",
  "new-releases",
] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * The minimum a poster card needs. Deliberately not TitleDetailResponse: a
 * row is twenty of these, and twenty overviews is payload nobody renders.
 */
export interface TitleCard {
  id: string;
  type: "movie" | "series";
  title: string;
  year: number | null;
  posterPath: string | null;
}

export interface CatalogRowResponse {
  kind: CatalogKind;
  titles: TitleCard[];
  /** True when served without contacting the provider. */
  cached: boolean;
}
```

- [ ] **Step 2: Build and typecheck**

Run: `pnpm --filter @harbor/shared build >/dev/null && pnpm typecheck >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): catalog row DTOs"
```

---

### Task 2: Catalog schema and migration

**Files:**
- Modify: `packages/database/src/schema.ts` (append)
- Create: `packages/database/drizzle/00NN_*.sql` (generated)

**Interfaces:**
- Consumes: `titles` from `schema.ts`.
- Produces: `catalogRows`, `catalogEntries` table objects.

- [ ] **Step 1: Append the tables**

```ts
/**
 * Freshness lives on its own row, separate from membership.
 *
 * Stamped on the entries instead, a kind the provider returns EMPTY would
 * store no rows, therefore hold no timestamp, therefore look permanently
 * stale -- refetching on every request forever, for the one case guaranteed
 * to keep returning nothing.
 */
export const catalogRows = pgTable("catalog_rows", {
  kind: text("kind").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const catalogEntries = pgTable(
  "catalog_entries",
  {
    kind: text("kind")
      .notNull()
      .references(() => catalogRows.kind, { onDelete: "cascade" }),
    // Providers return RANKED order, and that ranking is the entire
    // information content of a "Popular" row. A SELECT without an explicit
    // ORDER BY on this column is unordered in PostgreSQL no matter what
    // order the rows were inserted in.
    position: integer("position").notNull(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.kind, table.position] })],
);
```

- [ ] **Step 2: Confirm the imports exist at the top of the file**

`pgTable`, `text`, `timestamp`, `integer`, `uuid`, `primaryKey` must all be imported from `drizzle-orm/pg-core`. Add any that are missing to the existing import.

Run: `pnpm --filter @harbor/database exec tsc --noEmit >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @harbor/database exec drizzle-kit generate`
Expected: a new `packages/database/drizzle/00NN_<name>.sql` plus a snapshot. Read the SQL and confirm it only CREATEs the two new tables — it must not ALTER or DROP anything existing.

- [ ] **Step 4: Build**

Run: `pnpm --filter @harbor/database build >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle
git commit -m "feat(database): catalog row and entry schema"
```

---

### Task 3: Catalog accessors

**Files:**
- Create: `packages/database/src/catalog.ts`
- Create: `packages/database/src/catalog.test.ts`
- Modify: `packages/database/src/index.ts` (add `export * from "./catalog.js";`)

**Interfaces:**
- Consumes: `upsertTitles(db, items) => Promise<string[]>` from `./titles.js`; `NormalizedTitle`; `catalogRows`, `catalogEntries` from Task 2.
- Produces:
  - `getCatalogFetchedAt(db: Db, kind: string): Promise<Date | null>`
  - `listCatalogTitles(db: Db, kind: string): Promise<StoredCatalogTitle[]>`
  - `saveCatalogRow(db: Db, kind: string, items: NormalizedTitle[], now: Date): Promise<void>`
  - `interface StoredCatalogTitle { id, type, title, year, posterPath }`

- [ ] **Step 1: Write the failing tests**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { migrationsFolder } from "./migrations-path.js";
import { getCatalogFetchedAt, listCatalogTitles, saveCatalogRow } from "./catalog.js";
import type { NormalizedTitle } from "./titles.js";

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
    await saveCatalogRow(db, "trending", [title(3), title(1), title(2)], new Date());

    const rows = await listCatalogTitles(db, "trending");
    expect(rows.map((r) => r.title)).toEqual(["Title 3", "Title 1", "Title 2"]);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/database exec vitest run src/catalog.test.ts`
Expected: FAIL — cannot resolve `./catalog.js`.

- [ ] **Step 3: Write the accessor module**

```ts
import { asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { catalogEntries, catalogRows, titles } from "./schema.js";
import { upsertTitles, type NormalizedTitle } from "./titles.js";

/** Exactly the fields a poster card renders. */
export interface StoredCatalogTitle {
  id: string;
  type: "movie" | "series";
  title: string;
  year: number | null;
  posterPath: string | null;
}

export async function getCatalogFetchedAt(db: Db, kind: string): Promise<Date | null> {
  const found = await db
    .select({ fetchedAt: catalogRows.fetchedAt })
    .from(catalogRows)
    .where(eq(catalogRows.kind, kind))
    .limit(1);
  return found[0]?.fetchedAt ?? null;
}

export async function listCatalogTitles(db: Db, kind: string): Promise<StoredCatalogTitle[]> {
  const rows = await db
    .select({
      id: titles.id,
      type: titles.type,
      title: titles.title,
      year: titles.year,
      posterPath: titles.posterPath,
    })
    .from(catalogEntries)
    .innerJoin(titles, eq(titles.id, catalogEntries.titleId))
    .where(eq(catalogEntries.kind, kind))
    // The ranking IS the row. Without this the order is whatever PostgreSQL
    // finds convenient.
    .orderBy(asc(catalogEntries.position));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    year: r.year,
    posterPath: r.posterPath,
  }));
}

/**
 * Replaces a row's membership and stamps its freshness together.
 *
 * The stamp and the entries are one transaction so a partial write can never
 * be cached as complete -- the failure the 3c-2a review found in
 * `detailFetchedAt`, where the freshness stamp committed ahead of the season
 * list and pinned a truncated row for the whole TTL.
 *
 * `upsertTitles` runs first and outside that transaction on purpose. Titles
 * are global and shared with search, the upsert is idempotent and carries its
 * own advisory lock, and a title existing without a catalog entry is the
 * ordinary state of every title search has ever returned.
 *
 * Delete-then-insert, not upsert, for the reason `replaceEpisodes` documents:
 * a title that has dropped out of Trending must actually leave.
 */
export async function saveCatalogRow(
  db: Db,
  kind: string,
  items: NormalizedTitle[],
  now: Date,
): Promise<void> {
  const titleIds = await upsertTitles(db, items);

  await db.transaction(async (tx) => {
    await tx
      .insert(catalogRows)
      .values({ kind, fetchedAt: now })
      .onConflictDoUpdate({ target: catalogRows.kind, set: { fetchedAt: now } });

    await tx.delete(catalogEntries).where(eq(catalogEntries.kind, kind));

    if (titleIds.length > 0) {
      await tx.insert(catalogEntries).values(
        titleIds.map((titleId, index) => ({ kind, position: index, titleId })),
      );
    }
  });
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/database/src/index.ts`:

```ts
export * from "./catalog.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @harbor/database exec vitest run src/catalog.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Prove the ordering guard is load-bearing**

Remove `.orderBy(asc(catalogEntries.position))` from `listCatalogTitles`, re-run.
Expected: the provider-order test fails (or becomes flaky — if it still passes, insert 20 titles in the test instead of 3 and try again, because PostgreSQL may coincidentally return small result sets in insertion order).
Restore the line and confirm the suite is green again.

- [ ] **Step 7: Build and commit**

```bash
pnpm --filter @harbor/database build
git add packages/database/src/catalog.ts packages/database/src/catalog.test.ts packages/database/src/index.ts
git commit -m "feat(database): catalog row accessors"
```

---

### Task 4: Provider catalog capability

**Files:**
- Modify: `apps/server/src/modules/metadata/providers/types.ts`
- Modify: `apps/server/src/modules/metadata/providers/tmdb.ts`
- Create: `apps/server/src/modules/metadata/providers/tmdb-catalog.test.ts`

**Interfaces:**
- Consumes: `CatalogKind` from `@harbor/shared`; `searchItemSchema`, `searchResponseSchema`, `normalize`, `parseOrUnavailable`, `call` in `tmdb.ts`.
- Produces: `MetadataProvider.catalogs: readonly CatalogKind[]` and `MetadataProvider.getCatalog(kind, language, signal): Promise<NormalizedTitle[]>`.

- [ ] **Step 1: Extend the provider interface**

In `types.ts`, add the import and the two members:

```ts
import type { CatalogKind } from "@harbor/shared";
```

```ts
  /**
   * The catalog kinds this provider can actually serve.
   *
   * A capability list rather than four methods, because the rule above still
   * holds: a method that throws NotImplemented makes the contract a lie. A
   * provider that cannot serve New Releases omits the kind and Harbor hides
   * that row instead of rendering an error.
   */
  readonly catalogs: readonly CatalogKind[];
  getCatalog(
    kind: CatalogKind,
    language: string,
    signal: AbortSignal,
  ): Promise<NormalizedTitle[]>;
```

- [ ] **Step 2: Write the failing tests**

Create `tmdb-catalog.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

describe("tmdb getCatalog", () => {
  it("advertises all four kinds", () => {
    const provider = createTmdbProvider("key");
    expect([...provider.catalogs].sort()).toEqual([
      "new-releases",
      "popular-movies",
      "popular-series",
      "trending",
    ]);
  });

  it("requests the right endpoint per kind", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(json({ results: [] }));
    }) as unknown as typeof fetch;
    const provider = createTmdbProvider("key", { baseUrl: "http://x", fetchImpl });

    await provider.getCatalog("trending", "en-US", SIGNAL());
    await provider.getCatalog("popular-movies", "en-US", SIGNAL());
    await provider.getCatalog("popular-series", "en-US", SIGNAL());
    await provider.getCatalog("new-releases", "en-US", SIGNAL());

    expect(urls[0]).toContain("/trending/all/week");
    expect(urls[1]).toContain("/movie/popular");
    expect(urls[2]).toContain("/tv/popular");
    expect(urls[3]).toContain("/movie/now_playing");
  });

  it("supplies media_type for single-type endpoints, which TMDB omits there", async () => {
    // /movie/popular and /tv/popular return no media_type at all. normalize()
    // drops anything that is not "movie" or "tv", so without this the row
    // would come back empty and look like an outage.
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(
          json({ results: [{ id: 78, title: "Blade Runner" }] }),
        )) as unknown as typeof fetch,
    });

    const results = await provider.getCatalog("popular-movies", "en-US", SIGNAL());

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("movie");
  });

  it("trusts media_type on the trending endpoint, which mixes types", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(
          json({
            results: [
              { id: 1, media_type: "tv", name: "A Series" },
              { id: 2, media_type: "movie", title: "A Film" },
              { id: 3, media_type: "person", name: "An Actor" },
            ],
          }),
        )) as unknown as typeof fetch,
    });

    const results = await provider.getCatalog("trending", "en-US", SIGNAL());

    // The person is dropped: people are not watchable and must not enter the
    // catalog.
    expect(results.map((r) => r.type)).toEqual(["series", "movie"]);
  });

  it("classifies a malformed payload as an outage", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() => Promise.resolve(json({ results: "nope" }))) as unknown as typeof fetch,
    });

    await expect(provider.getCatalog("trending", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-catalog.test.ts`
Expected: FAIL — `provider.getCatalog is not a function`.

- [ ] **Step 4: Implement in the adapter**

Add near the top of `tmdb.ts`:

```ts
import { type CatalogKind } from "@harbor/shared";

/**
 * `/movie/*` and `/tv/*` return no `media_type`, but multi-search does and
 * `normalize()` requires it. The adapter supplies it for the single-type
 * endpoints and trusts it on `/trending/all/week`, which genuinely mixes
 * movies, series and people.
 */
const CATALOG_ENDPOINTS: Record<CatalogKind, { path: string; mediaType?: "movie" | "tv" }> = {
  trending: { path: "/trending/all/week" },
  "popular-movies": { path: "/movie/popular", mediaType: "movie" },
  "popular-series": { path: "/tv/popular", mediaType: "tv" },
  "new-releases": { path: "/movie/now_playing", mediaType: "movie" },
};

const CATALOG_KINDS_SUPPORTED = Object.keys(CATALOG_ENDPOINTS) as CatalogKind[];
```

Add these two members to the object returned by `createTmdbProvider`:

```ts
    catalogs: CATALOG_KINDS_SUPPORTED,

    async getCatalog(
      kind: CatalogKind,
      language: string,
      signal: AbortSignal,
    ): Promise<NormalizedTitle[]> {
      const endpoint = CATALOG_ENDPOINTS[kind];
      const payload = parseOrUnavailable(
        searchResponseSchema,
        await call(endpoint.path, new URLSearchParams({ language }), signal),
      );

      return (payload.results ?? []).flatMap((raw) => {
        const item = searchItemSchema.safeParse(raw);
        if (!item.success) return [];
        const withType =
          endpoint.mediaType === undefined
            ? item.data
            : { ...item.data, media_type: endpoint.mediaType };
        const normalized = normalize(withType);
        return normalized ? [normalized] : [];
      });
    },
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-catalog.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove the media_type guard is load-bearing**

Change `trending: { path: "/trending/all/week" }` to `trending: { path: "/trending/all/week", mediaType: "movie" }`.
Expected: the trending test fails — the series is mislabelled as a movie.
Restore it.

- [ ] **Step 7: Fix the other implementations of the interface**

Run: `pnpm typecheck 2>&1 | grep "error TS"`
Every test fake implementing `MetadataProvider` now fails to compile. For each, add:

```ts
  catalogs: ["trending", "popular-movies", "popular-series", "new-releases"],
  getCatalog: () => Promise.resolve([]),
```

Adjust per fake if a test needs real catalog data.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck >/dev/null && pnpm --filter @harbor/server test >/dev/null && echo OK`
Expected: `OK`

```bash
git add apps/server/src/modules/metadata/providers
git commit -m "feat(metadata): provider catalog capability and TMDB rows"
```

---

### Task 5: Catalog fetch with cache-on-read

**Files:**
- Create: `apps/server/src/modules/metadata/catalog.ts`
- Create: `apps/server/src/modules/metadata/catalog.test.ts`

**Interfaces:**
- Consumes: `getCatalogFetchedAt`, `listCatalogTitles`, `saveCatalogRow` (Task 3); `loadProvider` from `./config.js`; `DetailDeps` shape from `./detail.js`.
- Produces:
  - `CATALOG_TTL_MS`
  - `class CatalogKindUnsupportedError extends Error`
  - `fetchCatalogRow(deps: CatalogDeps, kind: CatalogKind): Promise<CatalogRowResponse>`
  - `interface CatalogDeps { db, harborSecret, now?, providerFactory?, tmdbBaseUrl? }`

- [ ] **Step 1: Write the failing tests**

Model the harness on `apps/server/src/modules/metadata/detail.test.ts` — same container setup, same `configure()` helper that stores an encrypted TMDB key. Add:

```ts
describe("fetchCatalogRow", () => {
  it("fetches once and serves the second call from cache", async () => {
    await configure();
    const calls = { catalog: 0 };
    const provider = fakeCatalogProvider(calls);

    const first = await fetchCatalogRow(deps(provider), "trending");
    const second = await fetchCatalogRow(deps(provider), "trending");

    expect(calls.catalog).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.titles).toHaveLength(2);
  });

  it("refetches once the TTL has passed", async () => {
    await configure();
    const calls = { catalog: 0 };
    const provider = fakeCatalogProvider(calls);

    await fetchCatalogRow(deps(provider), "trending");
    await fetchCatalogRow(
      deps(provider, () => new Date(Date.now() + CATALOG_TTL_MS + 60_000)),
      "trending",
    );

    expect(calls.catalog).toBe(2);
  });

  it("serves a stale row when the provider is unavailable", async () => {
    await configure();
    await fetchCatalogRow(deps(fakeCatalogProvider({ catalog: 0 })), "trending");

    const result = await fetchCatalogRow(
      deps(failingCatalog("unavailable"), () => new Date(Date.now() + CATALOG_TTL_MS + 60_000)),
      "trending",
    );

    expect(result.titles).toHaveLength(2);
    expect(result.cached).toBe(true);
  });

  it("does not serve a stale row when the provider rejects the key", async () => {
    // A rejected credential is an administrator problem. Hiding it behind
    // stale data means the home screen looks fine forever while nothing
    // refreshes.
    await configure();
    await fetchCatalogRow(deps(fakeCatalogProvider({ catalog: 0 })), "trending");

    await expect(
      fetchCatalogRow(
        deps(failingCatalog("unauthorized"), () => new Date(Date.now() + CATALOG_TTL_MS + 60_000)),
        "trending",
      ),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rethrows when the provider is unavailable and nothing was ever cached", async () => {
    await configure();
    await expect(
      fetchCatalogRow(deps(failingCatalog("unavailable")), "trending"),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });

  it("rejects a kind the provider does not advertise", async () => {
    await configure();
    const provider = { ...fakeCatalogProvider({ catalog: 0 }), catalogs: ["trending"] as const };

    await expect(
      fetchCatalogRow(deps(provider as unknown as MetadataProvider), "new-releases"),
    ).rejects.toBeInstanceOf(CatalogKindUnsupportedError);
  });

  it("serves an empty row from cache instead of refetching it every time", async () => {
    await configure();
    const calls = { catalog: 0 };
    const provider = emptyCatalogProvider(calls);

    await fetchCatalogRow(deps(provider), "new-releases");
    const second = await fetchCatalogRow(deps(provider), "new-releases");

    expect(calls.catalog).toBe(1);
    expect(second.titles).toHaveLength(0);
    expect(second.cached).toBe(true);
  });
});
```

The helpers, in full:

```ts
interface Calls {
  catalog: number;
}

function card(id: number, title: string): NormalizedTitle {
  return {
    type: "movie",
    title,
    originalTitle: null,
    year: 1982,
    overview: null,
    posterPath: "/p.jpg",
    backdropPath: null,
    externalIds: [{ source: "tmdb", externalId: String(id) }],
  };
}

const ALL_KINDS = ["trending", "popular-movies", "popular-series", "new-releases"] as const;

/** Every member the interface requires; individual tests override getCatalog. */
function baseProvider(): MetadataProvider {
  return {
    id: "tmdb",
    catalogs: ALL_KINDS,
    validateConfiguration: () => Promise.resolve(),
    search: () => Promise.resolve([]),
    getMovie: () => Promise.reject(new Error("unused")),
    getSeries: () => Promise.reject(new Error("unused")),
    getSeason: () => Promise.resolve([]),
    getCatalog: () => Promise.resolve([]),
  };
}

function fakeCatalogProvider(calls: Calls): MetadataProvider {
  return {
    ...baseProvider(),
    getCatalog: () => {
      calls.catalog += 1;
      return Promise.resolve([card(78, "Blade Runner"), card(1622, "Supernatural")]);
    },
  };
}

function emptyCatalogProvider(calls: Calls): MetadataProvider {
  return {
    ...baseProvider(),
    getCatalog: () => {
      calls.catalog += 1;
      return Promise.resolve([]);
    },
  };
}

function failingCatalog(kind: "unavailable" | "unauthorized"): MetadataProvider {
  return {
    ...baseProvider(),
    getCatalog: () => Promise.reject(new MetadataProviderError(kind, "failed")),
  };
}

function deps(provider: MetadataProvider, now?: () => Date): CatalogDeps {
  return {
    db,
    harborSecret: HARBOR_SECRET,
    providerFactory: () => provider,
    ...(now ? { now } : {}),
  };
}
```

`db`, `HARBOR_SECRET` and `configure()` come from the container harness — copy
those verbatim from `detail.test.ts`, which already stores an encrypted TMDB
key against a running PostgreSQL container.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/catalog.test.ts`
Expected: FAIL — cannot resolve `./catalog.js`.

- [ ] **Step 3: Implement the module**

```ts
import {
  getCatalogFetchedAt,
  listCatalogTitles,
  saveCatalogRow,
  type Db,
  type StoredCatalogTitle,
} from "@harbor/database";
import type { CatalogKind, CatalogRowResponse, TitleCard } from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

/**
 * Six hours. Trending genuinely moves day to day; "popular" barely moves week
 * to week. One constant covers both: four upstream calls per six hours for the
 * entire server is far inside any provider's budget, and a second freshness
 * concept would buy nothing at this scale.
 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export class CatalogKindUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogKindUnsupportedError";
  }
}

export interface CatalogDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
  tmdbBaseUrl?: string;
}

function toCard(row: StoredCatalogTitle): TitleCard {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    year: row.year,
    posterPath: row.posterPath,
  };
}

async function respond(
  deps: CatalogDeps,
  kind: CatalogKind,
  cached: boolean,
): Promise<CatalogRowResponse> {
  const rows = await listCatalogTitles(deps.db, kind);
  return { kind, titles: rows.map(toCard), cached };
}

function isFresh(fetchedAt: Date | null, now: Date): boolean {
  if (fetchedAt === null) return false;
  return now.getTime() - fetchedAt.getTime() <= CATALOG_TTL_MS;
}

export async function fetchCatalogRow(
  deps: CatalogDeps,
  kind: CatalogKind,
): Promise<CatalogRowResponse> {
  const now = deps.now ?? (() => new Date());

  const fetchedAt = await getCatalogFetchedAt(deps.db, kind);
  if (isFresh(fetchedAt, now())) {
    return respond(deps, kind, true);
  }

  const { provider, language } = await loadProvider(
    deps.db,
    deps.harborSecret,
    deps.providerFactory,
    deps.tmdbBaseUrl,
  );

  if (!provider.catalogs.includes(kind)) {
    throw new CatalogKindUnsupportedError(`The configured provider cannot serve "${kind}".`);
  }

  let titles;
  try {
    titles = await provider.getCatalog(kind, language, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (error) {
    // Same rule as title detail: an outage degrades to stale data, a rejected
    // key does not. Serving stale over a broken credential hides a problem
    // only an administrator can fix.
    if (
      error instanceof MetadataProviderError &&
      error.kind === "unavailable" &&
      fetchedAt !== null
    ) {
      return respond(deps, kind, true);
    }
    throw error;
  }

  await saveCatalogRow(deps.db, kind, titles, now());
  return respond(deps, kind, false);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/catalog.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the degraded guard is load-bearing**

Delete `error.kind === "unavailable" &&` from the catch. Re-run.
Expected: the `unauthorized` test fails.
Restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/catalog.ts apps/server/src/modules/metadata/catalog.test.ts
git commit -m "feat(metadata): catalog rows with cache-on-read"
```

---

### Task 6: Catalog route

**Files:**
- Modify: `apps/server/src/modules/metadata/routes.ts`
- Create: `apps/server/src/modules/metadata/catalog-routes.test.ts`

**Interfaces:**
- Consumes: `fetchCatalogRow`, `CatalogKindUnsupportedError` (Task 5); `CATALOG_KINDS` (Task 1).
- Produces: `GET /api/v1/catalog/:kind`.

- [ ] **Step 1: Write the failing tests**

Model on `detail-routes.test.ts`. Cover:

```ts
it("requires authentication", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/catalog/trending" });
  expect(res.statusCode).toBe(401);
});

it("rejects an unknown kind with 400 rather than reaching the provider", async () => {
  const res = await signedInGet("/api/v1/catalog/not-a-kind");
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe("VALIDATION_FAILED");
});

it("returns 409 CATALOG_KIND_UNSUPPORTED when the provider cannot serve it", async () => {
  const res = await signedInGet("/api/v1/catalog/new-releases");
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe("CATALOG_KIND_UNSUPPORTED");
});

it("returns the row for a supported kind", async () => {
  const res = await signedInGet("/api/v1/catalog/trending");
  expect(res.statusCode).toBe(200);
  expect(res.json().kind).toBe("trending");
  expect(Array.isArray(res.json().titles)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/catalog-routes.test.ts`
Expected: FAIL — 404 for every catalog URL.

- [ ] **Step 3: Add the schema, error mapping and route**

At the top of `routes.ts`:

```ts
import { CATALOG_KINDS, type CatalogRowResponse } from "@harbor/shared";
import { CatalogKindUnsupportedError, fetchCatalogRow } from "./catalog.js";

// z.enum over the shared tuple, so an unknown kind is a 400 from validation
// rather than a lookup miss deeper in the stack.
const CatalogParamsSchema = z.object({ kind: z.enum(CATALOG_KINDS) });
```

Inside `toHarborError`, before the fallthrough:

```ts
  if (error instanceof CatalogKindUnsupportedError) {
    // 409, not 404: the row is a real concept, this installation's provider
    // just cannot serve it. The client hides the row rather than showing an
    // error, and an operator reading logs sees a capability gap, not a bug.
    return new HarborError("CATALOG_KIND_UNSUPPORTED", error.message, 409);
  }
```

Alongside the title routes:

```ts
  fastify.get("/catalog/:kind", detailRateLimit, async (request): Promise<CatalogRowResponse> => {
    const parsed = CatalogParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
    }
    try {
      return await fetchCatalogRow(
        {
          db: fastify.db,
          harborSecret: fastify.env.HARBOR_SECRET,
          tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL,
        },
        parsed.data.kind,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/catalog-routes.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the auth guard covers the new route**

The guard fails closed by default, but confirm it rather than assume: temporarily add `/catalog/:kind` to the public-route allowlist in `apps/server/src/plugins/auth.ts`, re-run.
Expected: the authentication test fails.
Remove the entry.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/routes.ts apps/server/src/modules/metadata/catalog-routes.test.ts
git commit -m "feat(metadata): catalog row endpoint"
```

---

### Task 7: App shell

**Files:**
- Create: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/routes.tsx`
- Modify: `apps/web/src/pages/Home.tsx` (strip the nav card down to a placeholder heading; Task 9 replaces it)
- Create: `apps/web/src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: `useCurrentUser`, `useLogout` from `../auth`; `roleRank` from `@harbor/shared`.
- Produces: `AppShell` — a layout component rendering `<Outlet />` beneath a persistent header.

- [ ] **Step 1: Write the failing test**

This is the FIRST test in `apps/web`. `vitest.config.ts` already sets
`environment: "jsdom"` and `globals: true`, and `@testing-library/react` is
already a devDependency, so no setup file and no new dependency are needed.

`@testing-library/jest-dom` is deliberately NOT added. Its matchers
(`toBeInTheDocument`, `toHaveAttribute`) are unavailable, so the assertions
below use plain `expect` against DOM properties. Adding a matcher library for
three assertions is not worth a dependency.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

// The shell reads the session and the logout mutation. Mocking the module is
// simpler and less brittle than standing up a fake session endpoint, and the
// hooks themselves are covered by the auth tests.
const mockUser = vi.hoisted(() => ({ current: { username: "owner", role: "owner" } }));

vi.mock("../auth", () => ({
  useCurrentUser: () => ({ data: mockUser.current }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderShell(role: "owner" | "user" = "owner"): void {
  mockUser.current = { username: "owner", role };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/home"]}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("keeps unbuilt destinations reachable by keyboard and explains why they are inert", () => {
    renderShell();

    const discover = screen.getByRole("button", { name: /discover/i });

    // aria-disabled, NOT the disabled attribute. A natively disabled control
    // is removed from the tab order, so a keyboard or screen-reader user never
    // reaches it and never hears why it does nothing -- the defect recorded
    // against the title page Play button in docs/deferred-minors.md. It must
    // not be reproduced here.
    expect(discover.getAttribute("aria-disabled")).toBe("true");
    expect(discover.hasAttribute("disabled")).toBe(false);

    // And the explanation must actually be associated with it.
    const describedBy = discover.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toMatch(/later phase/i);
  });

  it("does not offer admin links to a plain user", () => {
    renderShell("user");
    expect(screen.queryByRole("link", { name: /invitations/i })).toBeNull();
  });

  it("offers admin links to an administrator", () => {
    renderShell("owner");
    expect(screen.queryByRole("link", { name: /invitations/i })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @harbor/web exec vitest run src/components/AppShell.test.tsx`
Expected: FAIL — cannot resolve `./AppShell`.

- [ ] **Step 3: Implement the shell**

```tsx
import { roleRank } from "@harbor/shared";
import type { JSX } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { useCurrentUser, useLogout } from "../auth";
import { Button } from "@/components/ui/button";

/**
 * A destination that exists in the roadmap but not yet in the app.
 *
 * Rendered with aria-disabled rather than the disabled attribute, and so it
 * stays in the tab order. A natively disabled control is unfocusable, which
 * means the explanation for why it is inert reaches nobody using a keyboard or
 * a screen reader -- the exact defect logged against the title page's Play
 * button. The "Soon" text carries the same information visually, so nothing
 * depends on colour alone.
 */
function ComingSoon({ label }: { label: string }): JSX.Element {
  const describedBy = `soon-${label.toLowerCase()}`;
  return (
    <>
      <Button
        variant="ghost"
        aria-disabled="true"
        aria-describedby={describedBy}
        className="text-muted-foreground"
        onPress={() => {
          // Intentionally inert. See ComingSoon's doc comment.
        }}
      >
        {label}
        <span className="ml-2 font-mono text-[10px] tracking-widest uppercase">Soon</span>
      </Button>
      <span id={describedBy} className="sr-only">
        {label} arrives in a later phase.
      </span>
    </>
  );
}

export function AppShell(): JSX.Element {
  const { data: user } = useCurrentUser();
  const logout = useLogout();
  const isAdmin = user != null && roleRank(user.role) >= roleRank("administrator");

  const linkClass = ({ isActive }: { isActive: boolean }): string =>
    isActive
      ? "text-foreground border-b-2 border-primary pb-0.5"
      : "text-muted-foreground hover:text-foreground";

  return (
    <div className="min-h-screen bg-background">
      {/* Sticky and transparent: on /home it sits over the hero backdrop, and
          the blur keeps the labels legible over whatever artwork loads. */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-[1600px] items-center gap-6 px-6 py-3">
          <Link to="/home" className="font-display text-lg tracking-tight">
            Harbor
          </Link>
          <NavLink to="/home" className={linkClass}>
            Home
          </NavLink>
          <ComingSoon label="Discover" />
          <ComingSoon label="Library" />
          <div className="flex-1" />
          <NavLink to="/search" className={linkClass}>
            Search
          </NavLink>
          {isAdmin ? (
            <>
              <NavLink to="/admin/metadata" className={linkClass}>
                Metadata
              </NavLink>
              <NavLink to="/admin/invitations" className={linkClass}>
                Invitations
              </NavLink>
            </>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            isDisabled={logout.isPending}
            onPress={() => {
              logout.mutate();
            }}
          >
            {logout.isPending ? "Signing out…" : "Sign out"}
          </Button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the router**

Add the import to `routes.tsx`:

```tsx
import { AppShell } from "./components/AppShell";
```

Then wrap only the signed-in pages. Setup, login, invite and register must stay outside the shell — they render before there is a user to build a header for.

```tsx
      { path: "setup", Component: Setup },
      { path: "login", Component: Login },
      { path: "invite/:token", Component: Invite },
      { path: "register", Component: Register },
      {
        Component: AppShell,
        children: [
          { path: "home", Component: Home },
          { path: "search", Component: Search },
          { path: "movie/:id", Component: Title },
          { path: "series/:id", Component: Title },
          { path: "series/:id/season/:season", Component: Title },
          { path: "admin/invitations", Component: Invitations },
          { path: "admin/metadata", Component: AdminMetadata },
        ],
      },
```

- [ ] **Step 5: Strip Home to a placeholder**

Replace `Home.tsx`'s body with a heading only — the nav buttons and sign-out now live in the shell and must not be duplicated:

```tsx
export function Home(): JSX.Element {
  return (
    <main className="mx-auto max-w-[1600px] px-6 py-8">
      <h1 className="font-display text-2xl">Home</h1>
    </main>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @harbor/web exec vitest run src/components/AppShell.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 7: Prove the a11y guard is load-bearing**

Change `aria-disabled="true"` to `isDisabled` on the `ComingSoon` button. Re-run.
Expected: the keyboard-reachability test fails.
Restore it.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && echo OK`
Expected: `OK`

```bash
git add apps/web/src/components/AppShell.tsx apps/web/src/components/AppShell.test.tsx apps/web/src/routes.tsx apps/web/src/pages/Home.tsx
git commit -m "feat(web): persistent app shell"
```

---

### Task 8: Catalog row component

**Files:**
- Create: `apps/web/src/catalog.ts`
- Create: `apps/web/src/components/PosterCard.tsx`
- Create: `apps/web/src/components/CatalogRow.tsx`
- Modify: `apps/web/src/index.css` (add the `no-scrollbar` utility)

**Interfaces:**
- Consumes: `request` from `./api-client`; `imageUrl` from `./images`; `TitleCard`, `CatalogKind`, `CatalogRowResponse` from `@harbor/shared`.
- Produces: `useCatalogRow(kind)`, `PosterCard`, `CatalogRow`.

- [ ] **Step 1: Add the query hook**

`apps/web/src/catalog.ts`:

```ts
import type { CatalogKind, CatalogRowResponse } from "@harbor/shared";
import { useQuery } from "@tanstack/react-query";
import { request } from "./api-client";

export const CATALOG_LABELS: Record<CatalogKind, string> = {
  trending: "Trending",
  "popular-movies": "Popular movies",
  "popular-series": "Popular series",
  "new-releases": "New releases",
};

export function useCatalogRow(kind: CatalogKind) {
  return useQuery({
    queryKey: ["catalog", kind],
    queryFn: () => request<CatalogRowResponse>(`/catalog/${kind}`),
    // The server already caches for six hours; refetching on every window
    // focus would spend requests to receive the identical payload.
    refetchOnWindowFocus: false,
    retry: false,
  });
}
```

- [ ] **Step 2: Add the scrollbar utility**

Append to `apps/web/src/index.css`:

```css
/* Hidden only where an explicit affordance replaces it.
   The season picker deliberately does NOT use this: there, the scrollbar was
   the sole indication more content existed. A catalog row has previous/next
   buttons and keyboard focus movement, so the native bar is redundant rather
   than load-bearing. */
@utility no-scrollbar {
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

- [ ] **Step 3: Write the poster card**

```tsx
import type { TitleCard } from "@harbor/shared";
import type { JSX } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { imageUrl } from "../images";

/**
 * A 2:3 poster with its box reserved, so a row does not reflow as artwork
 * arrives -- the same reason the search results and episode grid reserve
 * theirs.
 */
export function PosterCard({ item }: { item: TitleCard }): JSX.Element {
  const src = imageUrl(item.posterPath, "w342");
  const [failed, setFailed] = useState(false);
  const to = `/${item.type === "movie" ? "movie" : "series"}/${item.id}`;

  return (
    <li className="w-[150px] shrink-0 snap-start">
      <Link
        to={to}
        className="block rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {src === null || failed ? (
          <div aria-hidden="true" className="aspect-2/3 w-full rounded-lg bg-secondary" />
        ) : (
          <img
            src={src}
            // Decorative: the title is rendered as text below and is already
            // the link's accessible name.
            alt=""
            loading="lazy"
            className="aspect-2/3 w-full rounded-lg object-cover"
            onError={() => {
              setFailed(true);
            }}
          />
        )}
        <p className="mt-2 line-clamp-2 text-sm">{item.title}</p>
        {item.year === null ? null : (
          <p className="font-mono text-xs text-muted-foreground">{item.year}</p>
        )}
      </Link>
    </li>
  );
}
```

- [ ] **Step 4: Write the row**

```tsx
import type { CatalogKind } from "@harbor/shared";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CATALOG_LABELS, useCatalogRow } from "../catalog";
import { ApiError } from "../metadata";
import { PosterCard } from "./PosterCard";

const SCROLL_FRACTION = 0.8;

export function CatalogRow({ kind }: { kind: CatalogKind }): JSX.Element | null {
  const row = useCatalogRow(kind);
  const scroller = useRef<HTMLUListElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    setAtStart(el.scrollLeft <= 1);
    // The one-pixel slack absorbs sub-pixel layout rounding, which otherwise
    // leaves the "next" button enabled at the true end of the row.
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  useEffect(measure, [measure, row.data]);

  function scrollBy(direction: -1 | 1): void {
    const el = scroller.current;
    if (el === null) return;
    el.scrollBy({ left: direction * el.clientWidth * SCROLL_FRACTION, behavior: "smooth" });
  }

  // A row this installation's provider cannot serve is hidden, not broken.
  if (row.error instanceof ApiError && row.error.code === "CATALOG_KIND_UNSUPPORTED") return null;
  // An empty shelf communicates nothing.
  if (row.data && row.data.titles.length === 0) return null;

  const label = CATALOG_LABELS[kind];

  return (
    <section className="mt-10" aria-labelledby={`row-${kind}`}>
      <div className="flex items-center gap-3 px-6">
        <h2 id={`row-${kind}`} className="font-display text-xl">
          {label}
        </h2>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Scroll ${label} left`}
          isDisabled={atStart}
          onPress={() => {
            scrollBy(-1);
          }}
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Scroll ${label} right`}
          isDisabled={atEnd}
          onPress={() => {
            scrollBy(1);
          }}
        >
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {row.isError ? (
        // Scoped to this row on purpose: one failing provider call must not
        // blank the other three rows.
        <p role="alert" className="mt-3 px-6 text-sm text-muted-foreground">
          This row could not be loaded.
        </p>
      ) : (
        <ul
          ref={scroller}
          onScroll={measure}
          className="no-scrollbar mt-3 flex snap-x gap-4 overflow-x-auto overflow-y-hidden px-6 pb-2"
        >
          {row.isPending
            ? Array.from({ length: 8 }, (_, i) => (
                <li key={i} className="w-[150px] shrink-0" aria-hidden="true">
                  <Skeleton className="aspect-2/3 w-full rounded-lg" />
                </li>
              ))
            : (row.data?.titles ?? []).map((item) => <PosterCard key={item.id} item={item} />)}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Verify**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/catalog.ts apps/web/src/components/PosterCard.tsx apps/web/src/components/CatalogRow.tsx apps/web/src/index.css
git commit -m "feat(web): catalog row with poster cards"
```

---

### Task 9: Home screen

**Files:**
- Modify: `apps/web/src/pages/Home.tsx`

**Interfaces:**
- Consumes: `CATALOG_KINDS` from `@harbor/shared`; `useCatalogRow` (Task 8); `CatalogRow`; `imageUrl` from `../images`; `ApiError` from `../metadata`.
- Produces: the `/home` page.

- [ ] **Step 1: Implement**

```tsx
import { CATALOG_KINDS } from "@harbor/shared";
import type { JSX } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCatalogRow } from "../catalog";
import { CatalogRow } from "../components/CatalogRow";
import { imageUrl } from "../images";
import { ApiError } from "../metadata";

/**
 * The featured title is the first entry in Trending that has a backdrop --
 * deterministic, no rotation. Random or time-of-day selection makes the page
 * change under the reader between renders and makes the e2e assertion
 * unpinnable; rotation, if it is ever wanted, is a deliberate feature with its
 * own state rather than a side effect of rendering.
 */
function Hero(): JSX.Element | null {
  const trending = useCatalogRow("trending");
  const featured = trending.data?.titles[0];
  if (featured === undefined) return null;

  const src = imageUrl(featured.posterPath, "w780");

  return (
    <section className="relative">
      {src === null ? null : (
        <div aria-hidden="true" className="absolute inset-0 -z-10 overflow-hidden">
          <img src={src} alt="" className="h-full w-full scale-110 object-cover blur-2xl" />
          <div className="absolute inset-0 bg-background/80" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background" />
        </div>
      )}
      <div className="px-6 pt-16 pb-10">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Featured
        </p>
        <h1 className="mt-2 font-display text-4xl tracking-tight sm:text-5xl">{featured.title}</h1>
        <Link
          to={`/${featured.type === "movie" ? "movie" : "series"}/${featured.id}`}
          className="mt-5 inline-block rounded-full bg-primary px-6 py-2 text-sm text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          View details
        </Link>
      </div>
    </section>
  );
}

export function Home(): JSX.Element {
  const trending = useCatalogRow("trending");

  // One panel, not four broken rows: with no provider configured every row
  // fails identically, and repeating the same message four times tells the
  // reader nothing extra while burying the action that fixes it.
  const notConfigured =
    trending.error instanceof ApiError && trending.error.code === "METADATA_NOT_CONFIGURED";

  if (notConfigured) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Alert>
          <AlertDescription>
            Harbor has no metadata provider yet, so there is nothing to show here.{" "}
            <Link className="underline" to="/admin/metadata">
              Configure a metadata provider
            </Link>
            .
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1600px] pb-16">
      <Hero />
      {CATALOG_KINDS.map((kind) => (
        <CatalogRow key={kind} kind={kind} />
      ))}
    </main>
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && pnpm build >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/Home.tsx
git commit -m "feat(web): home screen with featured hero and catalog rows"
```

---

### Task 10: End-to-end coverage

**Files:**
- Modify: `e2e/scripts/tmdb-fixture.mjs`
- Create: `e2e/tests/06-home.spec.ts`

**Interfaces:**
- Consumes: the fixture's existing `MOVIE_DETAIL` / `SERIES_DETAIL` constants and its bearer-token check.
- Produces: fixture routes for the four catalog endpoints; a home-screen spec.

- [ ] **Step 1: Add the catalog endpoints to the fixture**

Before the final 404 in the request handler:

```js
// Catalog rows. /movie/* and /tv/* deliberately omit media_type, exactly as
// TMDB does -- the adapter has to supply it, and a fixture that helpfully
// included it would hide that bug.
const CATALOG = {
  "/trending/all/week": [
    { id: 1622, media_type: "tv", name: "Supernatural", poster_path: "/sn.jpg", first_air_date: "2005-09-13" },
    { id: 78, media_type: "movie", title: "Blade Runner", poster_path: "/poster.jpg", release_date: "1982-06-25" },
  ],
  "/movie/popular": [
    { id: 78, title: "Blade Runner", poster_path: "/poster.jpg", release_date: "1982-06-25" },
  ],
  "/tv/popular": [
    { id: 1622, name: "Supernatural", poster_path: "/sn.jpg", first_air_date: "2005-09-13" },
  ],
  "/movie/now_playing": [],
};

if (CATALOG[url.pathname]) {
  send(res, 200, { results: CATALOG[url.pathname] });
  return;
}
```

`/movie/now_playing` returns an empty list on purpose: it exercises both the empty-row-is-hidden rule and the empty-row-freshness case from Task 3.

- [ ] **Step 2: Write the spec**

```ts
import { expect, test, type Page } from "@playwright/test";

const OWNER = { username: "e2eowner", password: "correct-horse-battery-staple" };

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
}

test("home shows the catalog rows the provider can serve", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Trending" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Popular movies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Popular series" })).toBeVisible();

  // The fixture returns nothing for now_playing. An empty shelf says nothing,
  // so the row is hidden rather than rendered blank.
  await expect(page.getByRole("heading", { name: "New releases" })).toHaveCount(0);
});

test("a poster opens its title page", async ({ page }) => {
  await signIn(page);

  const trending = page.getByRole("region", { name: "Trending" });
  await trending.getByRole("link", { name: /blade runner/i }).first().click();

  await expect(page).toHaveURL(/\/movie\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Blade Runner", level: 1 })).toBeVisible();
});

test("posters actually render", async ({ page }) => {
  await signIn(page);

  const poster = page
    .getByRole("region", { name: "Popular movies" })
    .getByRole("link")
    .first()
    .locator("img");

  // naturalWidth, not visibility: a broken image is still "visible" to
  // Playwright, which is how a size missing from the proxy allowlist slipped
  // through in 3c-2a.
  await expect
    .poll(async () =>
      poster.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBeGreaterThan(0);
});

test("the shell reaches search and marks unbuilt destinations", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("button", { name: /discover/i })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await page.getByRole("link", { name: /^search$/i }).click();
  await expect(page).toHaveURL(/\/search$/);
});

test("row scroll buttons reflect position", async ({ page }) => {
  await signIn(page);

  const trending = page.getByRole("region", { name: "Trending" });
  const left = trending.getByRole("button", { name: /scroll trending left/i });

  // At rest the row is at its start, so "left" has nowhere to go. Without
  // this the enable/disable logic is untested anywhere -- jsdom does not
  // implement scroll geometry, so a unit test cannot cover it either.
  await expect(left).toBeDisabled();
});

test("catalog rows require authentication", async ({ browser }) => {
  const anonymous = await browser.newContext();
  const response = await anonymous.request.get("/api/v1/catalog/trending");
  expect(response.status()).toBe(401);
  await anonymous.close();
});
```

- [ ] **Step 3: Run the suite**

Run: `pnpm test:e2e`
Expected: all specs pass, including the five new ones.

Note: the numeric filename prefix matters — the suite shares one database and `06-home` depends on `01` creating the owner and `03` configuring the provider.

- [ ] **Step 4: Commit**

```bash
git add e2e/scripts/tmdb-fixture.mjs e2e/tests/06-home.spec.ts
git commit -m "test(e2e): home catalog rows and shell navigation"
```

---

### Task 11: Full verification and manual checkpoint

- [ ] **Step 1: Run everything**

```bash
pnpm lint >/dev/null && echo LINT_OK && \
pnpm typecheck >/dev/null && echo TYPECHECK_OK && \
pnpm test >/dev/null && echo UNIT_OK && \
pnpm build >/dev/null && echo BUILD_OK && \
pnpm test:e2e
```

Expected: every marker prints and the e2e suite passes.

- [ ] **Step 2: Build and smoke the container**

```bash
pnpm docker:build && pnpm docker:smoke
```

Expected: `SMOKE PASSED`. `pnpm build` cannot catch a missing `COPY` in the Dockerfile; only this can.

- [ ] **Step 3: Deploy for manual review — recreate, never restart**

```bash
docker rm -f harbor-3c2b-app
docker run -d --name harbor-3c2b-app --restart unless-stopped \
  -p 3404:3000 -v harbor_3c2b_data:/data \
  -e DATABASE_URL="postgresql://harbor:harbor@host.docker.internal:55444/harbor" \
  -e HARBOR_BASE_URL="http://localhost:3404" \
  -e HARBOR_SECRET="0123456789abcdef0123456789abcdef" \
  -e HARBOR_LOG_LEVEL=warn \
  --add-host host.docker.internal:host-gateway \
  harbor:dev
```

`docker restart` runs the container against the image ID it was **created**
from, so re-tagging an image and restarting silently keeps serving the old
build. That happened in 3c-2a and sent the user to review a stale bundle three
times.

- [ ] **Step 4: Verify the served bundle is the new one**

```bash
curl -s http://localhost:3404/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Compare against `ls apps/server/public/assets/`. The hashes must match. Never
report the app as deployed without this check.

- [ ] **Step 5: Hand to the user**

Ask them to confirm: rows render with artwork; the hero shows a featured title;
previous/next buttons enable and disable at the ends of a row; Tab walks the
posters and the row scrolls to follow focus; New Releases is absent rather than
empty; the shell navigates and Discover/Library read as "Soon".

---

## Self-Review Notes

Checked against the spec:

| Spec requirement | Task |
| --- | --- |
| `CatalogKind`, `TitleCard`, `CatalogRowResponse` | 1 |
| `catalog_rows` / `catalog_entries`, freshness split | 2, 3 |
| Ordered membership, delete-then-insert, transaction | 3 |
| Provider capability list + `getCatalog` | 4 |
| TMDB endpoint mapping, `media_type` handling | 4 |
| 6h TTL, cache-on-read, degraded stale, unauthorized refusal | 5 |
| Unsupported kind → 409, unconfigured → existing code | 5, 6 |
| Per-row endpoint, auth, rate limit | 6 |
| App shell, disabled destinations reachable by keyboard | 7 |
| Rows with explicit scroll affordance, hidden native bar | 8 |
| Deterministic hero, per-row failure isolation, empty rows hidden | 8, 9 |
| Fixture endpoints and e2e coverage | 10 |
