# Harbor Phase 3c-2c — Discover / Genre Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/discover` page that browses the catalog by genre — a Movies|Series toggle and genre picker feeding a poster grid with Load more — and the app shell's Discover nav going live.

**Architecture:** The metadata provider gains `supportsDiscover`, `getGenres(type)`, and `discoverByGenre(type, genreId, page)`. Genre lists are cached in PostgreSQL (one row per type, 7-day TTL, cache-on-read); discover results are proxied through (titles upserted for detail linkage, ordering not persisted). Two REST endpoints, reusing `TitleCard`. The web app adds a URL-driven Discover page reusing `PosterCard`.

**Tech Stack:** TypeScript 6.0.3, Fastify 5.10.0, Drizzle 0.45.2, Zod 4.4.3, React 19.2.7, shadcn on the React Aria base, TanStack Query, React Router 8.2.0, Vitest 4.1.10, Playwright 1.61.1.

## Global Constraints

- **Never** add `Co-Authored-By` trailers or any AI attribution to a commit message or PR body.
- `packages/*` and `apps/server` use `moduleResolution: nodenext` — every relative import needs an explicit `.js` extension. `apps/web` uses `bundler` — imports are extensionless.
- Strict TypeScript. No unjustified `any`. Runtime validation at every external boundary (TMDB payloads via Zod).
- Pin dependency versions exactly — no carets. (No new deps expected in this phase.)
- Never pipe a verification command through `tail`/`grep` when its exit code matters; a pipe replaces the exit status. Use `cmd >/dev/null && echo OK`.
- Every guard added must have a load-bearing test: break the guard, watch a specific test fail, restore it. **Server-side load-bearing proofs must be done at the unit level** — the e2e suite can run against a stale server `dist` (turbo cache), so it cannot be trusted for load-bearing.
- Migrations are generated with `pnpm --filter @harbor/database exec drizzle-kit generate`, never hand-written. Read the generated SQL and confirm it only creates the new table.
- Run `pnpm --filter @harbor/database build` after changing `packages/database`, or `apps/server` compiles against a stale `dist`.
- `DiscoverType` uses Harbor's vocabulary (`"movie" | "series"`); the TMDB adapter maps `series` to TMDB's `tv` internally so provider naming never leaks outward.

---

### Task 1: Shared discover DTOs

**Files:**
- Modify: `packages/shared/src/index.ts` (append; add one error code)

**Interfaces:**
- Produces: `DiscoverType`, `Genre`, `GenreListResponse`, `DiscoverResponse`, and the `DISCOVER_UNSUPPORTED` error code.

- [ ] **Step 1: Add the error code**

In `packages/shared/src/index.ts`, add `"DISCOVER_UNSUPPORTED"` to the `ERROR_CODES` tuple, next to `"CATALOG_KIND_UNSUPPORTED"`:

```ts
  "CATALOG_KIND_UNSUPPORTED",
  "DISCOVER_UNSUPPORTED",
  "IMAGE_UNAVAILABLE",
```

- [ ] **Step 2: Append the DTOs**

```ts
/** The two things Harbor can browse by genre. Harbor's own vocabulary --
 *  the TMDB adapter maps "series" to TMDB's "tv". */
export type DiscoverType = "movie" | "series";

export interface Genre {
  /** The provider's genre id as a string (TMDB's are numeric). */
  id: string;
  name: string;
}

export interface GenreListResponse {
  type: DiscoverType;
  genres: Genre[];
  /** True when served without contacting the provider. */
  cached: boolean;
}

export interface DiscoverResponse {
  type: DiscoverType;
  genreId: string;
  page: number;
  totalPages: number;
  titles: TitleCard[];
}
```

- [ ] **Step 3: Build and typecheck**

Run: `pnpm --filter @harbor/shared build >/dev/null && pnpm typecheck >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): discover and genre DTOs"
```

---

### Task 2: Genre cache schema and migration

**Files:**
- Modify: `packages/database/src/schema.ts` (append)
- Create: `packages/database/drizzle/00NN_*.sql` (generated)

**Interfaces:**
- Produces: the `genreCache` table object.

- [ ] **Step 1: Append the table**

```ts
/**
 * One row per discover type, holding that type's whole genre list as JSON.
 *
 * Genre lists are tiny and near-immutable and read on every Discover load --
 * an ideal thing to cache. Discover *results* are deliberately not cached
 * (their key space is huge and cold); only this list is.
 */
export const genreCache = pgTable("genre_cache", {
  // 'movie' | 'series' -- kept a plain text column so the database layer stays
  // agnostic about the vocabulary, exactly as catalog_rows.kind is.
  type: text("type").primaryKey(),
  genres: jsonb("genres").$type<{ id: string; name: string }[]>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 2: Confirm imports**

`pgTable`, `text`, `jsonb`, `timestamp` must be imported from `drizzle-orm/pg-core` at the top of the file. They already are (used by existing tables); confirm.

Run: `pnpm --filter @harbor/database exec tsc --noEmit >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @harbor/database exec drizzle-kit generate`
Expected: a new `packages/database/drizzle/00NN_<name>.sql` plus snapshot. Read the SQL — it must `CREATE TABLE "genre_cache"` and nothing else. If it ALTERs or DROPs any existing table, stop and report BLOCKED.

- [ ] **Step 4: Build and commit**

```bash
pnpm --filter @harbor/database build
git add packages/database/src/schema.ts packages/database/drizzle
git commit -m "feat(database): genre cache schema"
```

---

### Task 3: Genre cache accessors

**Files:**
- Create: `packages/database/src/genres.ts`
- Create: `packages/database/src/genres.test.ts`
- Modify: `packages/database/src/index.ts` (add `export * from "./genres.js";`)

**Interfaces:**
- Consumes: `genreCache` from `./schema.js`.
- Produces:
  - `interface StoredGenre { id: string; name: string }`
  - `getGenresFetchedAt(db: Db, type: string): Promise<Date | null>`
  - `listCachedGenres(db: Db, type: string): Promise<StoredGenre[]>`
  - `saveGenres(db: Db, type: string, genres: StoredGenre[], now: Date): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Model the container harness on `packages/database/src/catalog.test.ts` (same `PostgreSqlContainer` setup, `beforeAll`/`afterAll`, and a `beforeEach` truncate). Create `genres.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/database exec vitest run src/genres.test.ts`
Expected: FAIL — cannot resolve `./genres.js`.

- [ ] **Step 3: Implement the accessors**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { genreCache } from "./schema.js";

export interface StoredGenre {
  id: string;
  name: string;
}

export async function getGenresFetchedAt(db: Db, type: string): Promise<Date | null> {
  const found = await db
    .select({ fetchedAt: genreCache.fetchedAt })
    .from(genreCache)
    .where(eq(genreCache.type, type))
    .limit(1);
  return found[0]?.fetchedAt ?? null;
}

export async function listCachedGenres(db: Db, type: string): Promise<StoredGenre[]> {
  const found = await db
    .select({ genres: genreCache.genres })
    .from(genreCache)
    .where(eq(genreCache.type, type))
    .limit(1);
  return found[0]?.genres ?? [];
}

/** Upserts the whole list for a type, replacing any prior list and stamping
 *  freshness. One statement, so the list and its timestamp are never torn. */
export async function saveGenres(
  db: Db,
  type: string,
  genres: StoredGenre[],
  now: Date,
): Promise<void> {
  await db
    .insert(genreCache)
    .values({ type, genres, fetchedAt: now })
    .onConflictDoUpdate({ target: genreCache.type, set: { genres, fetchedAt: now } });
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/database/src/index.ts`:

```ts
export * from "./genres.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @harbor/database exec vitest run src/genres.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Build and commit**

```bash
pnpm --filter @harbor/database build
git add packages/database/src/genres.ts packages/database/src/genres.test.ts packages/database/src/index.ts
git commit -m "feat(database): genre cache accessors"
```

---

### Task 4: Provider discover capability

**Files:**
- Modify: `apps/server/src/modules/metadata/providers/types.ts`
- Modify: `apps/server/src/modules/metadata/providers/tmdb.ts`
- Create: `apps/server/src/modules/metadata/providers/tmdb-discover.test.ts`

**Interfaces:**
- Consumes: `DiscoverType`, `Genre` from `@harbor/shared`; `searchItemSchema`, `searchResponseSchema`, `normalize`, `parseOrUnavailable`, `call` in `tmdb.ts`.
- Produces on `MetadataProvider`:
  - `readonly supportsDiscover: boolean`
  - `getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]>`
  - `discoverByGenre(type: DiscoverType, genreId: string, page: number, language: string, signal: AbortSignal): Promise<DiscoverResult>`
  - exported `interface DiscoverResult { titles: NormalizedTitle[]; page: number; totalPages: number }`

- [ ] **Step 1: Extend the interface**

In `types.ts`, add to the imports:

```ts
import type { CatalogKind, DiscoverType, Genre } from "@harbor/shared";
```

(The `CatalogKind` import already exists — add `DiscoverType, Genre` to it.)

Add near the other exported interfaces:

```ts
export interface DiscoverResult {
  titles: NormalizedTitle[];
  page: number;
  totalPages: number;
}
```

Add to the `MetadataProvider` interface after `getCatalog`:

```ts
  /**
   * Whether this provider can browse by genre. A capability flag, not a
   * throwing method: a provider that cannot discover sets this false and
   * Harbor hides the feature rather than erroring.
   */
  readonly supportsDiscover: boolean;
  getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]>;
  discoverByGenre(
    type: DiscoverType,
    genreId: string,
    page: number,
    language: string,
    signal: AbortSignal,
  ): Promise<DiscoverResult>;
```

- [ ] **Step 2: Write the failing tests**

Create `tmdb-discover.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

describe("tmdb discover capability", () => {
  it("advertises discover support", () => {
    expect(createTmdbProvider("key").supportsDiscover).toBe(true);
  });

  it("fetches the genre list for the right endpoint per type", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(json({ genres: [{ id: 28, name: "Action" }] }));
    }) as unknown as typeof fetch;
    const provider = createTmdbProvider("key", { baseUrl: "http://x", fetchImpl });

    const movie = await provider.getGenres("movie", "en-US", SIGNAL());
    await provider.getGenres("series", "en-US", SIGNAL());

    expect(urls[0]).toContain("/genre/movie/list");
    expect(urls[1]).toContain("/genre/tv/list");
    // ids are stringified for Harbor.
    expect(movie).toEqual([{ id: "28", name: "Action" }]);
  });

  it("drops a malformed genre entry without discarding the rest", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() =>
        Promise.resolve(json({ genres: [{ id: 28, name: "Action" }, { id: 35 }] }))) as unknown as typeof fetch,
    });

    expect(await provider.getGenres("movie", "en-US", SIGNAL())).toEqual([{ id: "28", name: "Action" }]);
  });

  it("classifies a malformed genre payload as an outage", async () => {
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: (() => Promise.resolve(json({ genres: "nope" }))) as unknown as typeof fetch,
    });

    await expect(provider.getGenres("movie", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("discovers by genre, hitting the right endpoint and passing page + genre", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json({ page: 2, total_pages: 9, results: [{ id: 78, title: "Blade Runner" }] }));
      }) as unknown as typeof fetch,
    });

    const result = await provider.discoverByGenre("movie", "878", 2, "en-US", SIGNAL());

    expect(urls[0]).toContain("/discover/movie");
    expect(urls[0]).toContain("with_genres=878");
    expect(urls[0]).toContain("page=2");
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(9);
    // /discover/movie omits media_type; the adapter injects it so normalize keeps the title.
    expect(result.titles).toHaveLength(1);
    expect(result.titles[0]?.type).toBe("movie");
  });

  it("maps series to the tv discover endpoint", async () => {
    const urls: string[] = [];
    const provider = createTmdbProvider("key", {
      baseUrl: "http://x",
      fetchImpl: ((url: string) => {
        urls.push(url);
        return Promise.resolve(json({ page: 1, total_pages: 1, results: [] }));
      }) as unknown as typeof fetch,
    });

    await provider.discoverByGenre("series", "18", 1, "en-US", SIGNAL());
    expect(urls[0]).toContain("/discover/tv");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-discover.test.ts`
Expected: FAIL — `provider.getGenres is not a function`.

- [ ] **Step 4: Implement in the adapter**

Add to the imports at the top of `tmdb.ts` (it already imports `CatalogKind` from `@harbor/shared` — extend it):

```ts
import type { CatalogKind, DiscoverType, Genre } from "@harbor/shared";
```

Also import the `DiscoverResult` type from `./types.js` (the file already imports from there):

```ts
import { MetadataProviderError, type DiscoverResult, type MetadataProvider } from "./types.js";
```

Add near `CATALOG_ENDPOINTS`:

```ts
// series -> tv is the only mapping TMDB needs; movie is identical.
const DISCOVER_TMDB_TYPE: Record<DiscoverType, "movie" | "tv"> = {
  movie: "movie",
  series: "tv",
};

// The genre list is parsed permissively at the outer level, then each entry
// individually -- so one malformed entry is dropped rather than failing the
// whole list, exactly as search results are handled.
const genreListSchema = z.object({ genres: z.array(z.unknown()).nullish() });
const genreItemSchema = z.object({ id: z.number(), name: z.string() });

const discoverResponseSchema = z.object({
  page: z.number(),
  total_pages: z.number(),
  results: z.array(z.unknown()).nullish(),
});
```

Add these members to the object returned by `createTmdbProvider`, next to `getCatalog`:

```ts
    supportsDiscover: true,

    async getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]> {
      const payload = parseOrUnavailable(
        genreListSchema,
        await call(`/genre/${DISCOVER_TMDB_TYPE[type]}/list`, new URLSearchParams({ language }), signal),
      );
      return (payload.genres ?? []).flatMap((raw) => {
        const g = genreItemSchema.safeParse(raw);
        // TMDB genre ids are numbers; Harbor carries them as strings.
        return g.success ? [{ id: String(g.data.id), name: g.data.name }] : [];
      });
    },

    async discoverByGenre(
      type: DiscoverType,
      genreId: string,
      page: number,
      language: string,
      signal: AbortSignal,
    ): Promise<DiscoverResult> {
      const params = new URLSearchParams({
        language,
        with_genres: genreId,
        page: String(page),
        include_adult: "false",
      });
      const payload = parseOrUnavailable(
        discoverResponseSchema,
        await call(`/discover/${DISCOVER_TMDB_TYPE[type]}`, params, signal),
      );
      // /discover/* omits media_type; inject it so normalize() keeps the rows.
      const mediaType = DISCOVER_TMDB_TYPE[type];
      const titles = (payload.results ?? []).flatMap((raw) => {
        const item = searchItemSchema.safeParse(raw);
        if (!item.success) return [];
        const normalized = normalize({ ...item.data, media_type: mediaType });
        return normalized ? [normalized] : [];
      });
      return { titles, page: payload.page, totalPages: payload.total_pages };
    },
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/providers/tmdb-discover.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Prove the media_type injection is load-bearing**

In `discoverByGenre`, remove `{ ...item.data, media_type: mediaType }` and pass `item.data` directly. Re-run.
Expected: the "discovers by genre" test fails — the movie is dropped by `normalize` (no media_type), so `titles` is empty.
Restore it.

- [ ] **Step 7: Fix the other provider fakes**

Run: `pnpm typecheck 2>&1 | grep "error TS"`
The full fakes (in `detail.test.ts`) implementing `MetadataProvider` now fail to compile. Add to each:

```ts
    supportsDiscover: true,
    getGenres: async () => [],
    discoverByGenre: async () => ({ titles: [], page: 1, totalPages: 1 }),
```

(The partial fakes in `search.test.ts` are typed `MetadataProvider` but already omit `getMovie`/`getSeries`/`getSeason`; leave them — they follow a minimal-fake convention and are excluded from tsc. If tsc flags them anyway, add the three members above.)

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck >/dev/null && pnpm --filter @harbor/server test >/dev/null && echo OK`
Expected: `OK`

```bash
git add apps/server/src/modules/metadata/providers apps/server/src/modules/metadata/detail.test.ts
git commit -m "feat(metadata): provider discover capability and TMDB genres"
```

---

### Task 5: Genre list service (cache-on-read)

**Files:**
- Create: `apps/server/src/modules/metadata/discover.ts`
- Create: `apps/server/src/modules/metadata/discover.test.ts`

**Interfaces:**
- Consumes: `getGenresFetchedAt`, `listCachedGenres`, `saveGenres`, `upsertTitles` (Task 3 + existing); `loadProvider` from `./config.js`; `DiscoverType`, `Genre`, `GenreListResponse`, `DiscoverResponse` from `@harbor/shared`.
- Produces:
  - `GENRE_TTL_MS`
  - `class DiscoverUnsupportedError extends Error`
  - `interface DiscoverDeps { db; harborSecret; now?; providerFactory?; tmdbBaseUrl? }`
  - `fetchGenres(deps: DiscoverDeps, type: DiscoverType): Promise<GenreListResponse>`

- [ ] **Step 1: Write the failing tests**

Model the harness on `apps/server/src/modules/metadata/catalog.test.ts` — same container, same `configure()` storing an encrypted TMDB key, and the `beforeEach` truncate must include `genre_cache` and `titles`. Add fakes shaped like catalog's `baseProvider` but with the discover members. Tests:

```ts
describe("fetchGenres", () => {
  it("fetches once and serves the second call from cache", async () => {
    await configure();
    const calls = { genres: 0 };
    const provider = fakeDiscoverProvider(calls);

    const first = await fetchGenres(deps(provider), "movie");
    const second = await fetchGenres(deps(provider), "movie");

    expect(calls.genres).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.genres).toEqual([{ id: "28", name: "Action" }]);
  });

  it("refetches once the TTL has passed", async () => {
    await configure();
    const calls = { genres: 0 };
    const provider = fakeDiscoverProvider(calls);

    await fetchGenres(deps(provider), "movie");
    await fetchGenres(deps(provider, () => new Date(Date.now() + GENRE_TTL_MS + 60_000)), "movie");

    expect(calls.genres).toBe(2);
  });

  it("serves stale genres when the provider is unavailable", async () => {
    await configure();
    await fetchGenres(deps(fakeDiscoverProvider({ genres: 0 })), "movie");

    const result = await fetchGenres(
      deps(failingDiscover("unavailable"), () => new Date(Date.now() + GENRE_TTL_MS + 60_000)),
      "movie",
    );

    expect(result.genres).toHaveLength(1);
    expect(result.cached).toBe(true);
  });

  it("does not serve stale genres when the provider rejects the key", async () => {
    await configure();
    await fetchGenres(deps(fakeDiscoverProvider({ genres: 0 })), "movie");

    await expect(
      fetchGenres(
        deps(failingDiscover("unauthorized"), () => new Date(Date.now() + GENRE_TTL_MS + 60_000)),
        "movie",
      ),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects when the provider does not support discover", async () => {
    await configure();
    const provider = { ...fakeDiscoverProvider({ genres: 0 }), supportsDiscover: false };

    await expect(
      fetchGenres(deps(provider as unknown as MetadataProvider), "movie"),
    ).rejects.toBeInstanceOf(DiscoverUnsupportedError);
  });
});
```

The helpers (place in the test file):

```ts
interface Calls { genres: number }
const ALL_KINDS = ["trending", "popular-movies", "popular-series", "new-releases"] as const;

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
    supportsDiscover: true,
    getGenres: () => Promise.resolve([]),
    discoverByGenre: () => Promise.resolve({ titles: [], page: 1, totalPages: 1 }),
  };
}

function fakeDiscoverProvider(calls: Calls): MetadataProvider {
  return {
    ...baseProvider(),
    getGenres: () => {
      calls.genres += 1;
      return Promise.resolve([{ id: "28", name: "Action" }]);
    },
  };
}

function failingDiscover(kind: "unavailable" | "unauthorized"): MetadataProvider {
  return { ...baseProvider(), getGenres: () => Promise.reject(new MetadataProviderError(kind, "failed")) };
}

function deps(provider: MetadataProvider, now?: () => Date): DiscoverDeps {
  return { db, harborSecret: HARBOR_SECRET, providerFactory: () => provider, ...(now ? { now } : {}) };
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover.test.ts`
Expected: FAIL — cannot resolve `./discover.js`.

- [ ] **Step 3: Implement `fetchGenres`**

```ts
import {
  getGenresFetchedAt,
  listCachedGenres,
  saveGenres,
  upsertTitles,
  type Db,
} from "@harbor/database";
import type {
  DiscoverResponse,
  DiscoverType,
  GenreListResponse,
  TitleCard,
} from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

/** Seven days. Genre taxonomies barely change; a week between refreshes is
 *  still far more current than the data ever moves. */
export const GENRE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export class DiscoverUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverUnsupportedError";
  }
}

export interface DiscoverDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
  tmdbBaseUrl?: string;
}

function isFresh(fetchedAt: Date | null, now: Date, ttl: number): boolean {
  if (fetchedAt === null) return false;
  return now.getTime() - fetchedAt.getTime() <= ttl;
}

async function loadDiscoverProvider(deps: DiscoverDeps): Promise<{ provider: MetadataProvider; language: string }> {
  const loaded = await loadProvider(deps.db, deps.harborSecret, deps.providerFactory, deps.tmdbBaseUrl);
  if (!loaded.provider.supportsDiscover) {
    throw new DiscoverUnsupportedError("The configured provider cannot browse by genre.");
  }
  return loaded;
}

export async function fetchGenres(deps: DiscoverDeps, type: DiscoverType): Promise<GenreListResponse> {
  const now = deps.now ?? (() => new Date());

  const fetchedAt = await getGenresFetchedAt(deps.db, type);
  if (isFresh(fetchedAt, now(), GENRE_TTL_MS)) {
    return { type, genres: await listCachedGenres(deps.db, type), cached: true };
  }

  const { provider, language } = await loadDiscoverProvider(deps);

  let genres;
  try {
    genres = await provider.getGenres(type, language, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (error) {
    // Same rule as the rest of the module: an outage degrades to stale data,
    // a rejected key does not.
    if (error instanceof MetadataProviderError && error.kind === "unavailable" && fetchedAt !== null) {
      return { type, genres: await listCachedGenres(deps.db, type), cached: true };
    }
    throw error;
  }

  await saveGenres(deps.db, type, genres, now());
  return { type, genres, cached: false };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the degraded guard is load-bearing**

Delete `error.kind === "unavailable" &&` from the catch. Re-run.
Expected: the `unauthorized` test fails.
Restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/discover.ts apps/server/src/modules/metadata/discover.test.ts
git commit -m "feat(metadata): genre list service with cache-on-read"
```

---

### Task 6: Discover-by-genre service (proxy-through)

**Files:**
- Modify: `apps/server/src/modules/metadata/discover.ts`
- Modify: `apps/server/src/modules/metadata/discover.test.ts`

**Interfaces:**
- Consumes: `discoverByGenre` on the provider; `upsertTitles`; `loadDiscoverProvider` (Task 5, internal).
- Produces: `fetchDiscover(deps: DiscoverDeps, type: DiscoverType, genreId: string, page: number): Promise<DiscoverResponse>`

- [ ] **Step 1: Write the failing tests**

Add to `discover.test.ts`. Extend the `Calls` interface to `{ genres: number; discover: number }` and add a `fakeDiscoverResults` provider whose `discoverByGenre` returns two titles and increments `calls.discover`:

```ts
describe("fetchDiscover", () => {
  it("returns the provider's titles as cards, with paging info", async () => {
    await configure();
    const provider = {
      ...baseProvider(),
      discoverByGenre: () =>
        Promise.resolve({
          titles: [
            { type: "movie" as const, title: "Blade Runner", originalTitle: null, year: 1982, overview: null, posterPath: "/p.jpg", backdropPath: null, externalIds: [{ source: "tmdb", externalId: "78" }] },
          ],
          page: 2,
          totalPages: 9,
        }),
    };

    const result = await fetchDiscover(deps(provider), "movie", "878", 2);

    expect(result.type).toBe("movie");
    expect(result.genreId).toBe("878");
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(9);
    expect(result.titles).toHaveLength(1);
    expect(result.titles[0]?.title).toBe("Blade Runner");
  });

  it("upserts the titles so they are addressable by the detail page", async () => {
    await configure();
    const provider = {
      ...baseProvider(),
      discoverByGenre: () =>
        Promise.resolve({
          titles: [
            { type: "movie" as const, title: "Blade Runner", originalTitle: null, year: 1982, overview: null, posterPath: "/p.jpg", backdropPath: null, externalIds: [{ source: "tmdb", externalId: "78" }] },
          ],
          page: 1,
          totalPages: 1,
        }),
    };

    const result = await fetchDiscover(deps(provider), "movie", "878", 1);
    // The returned card's id is a real uuid the detail endpoint can resolve.
    expect(result.titles[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects when the provider does not support discover", async () => {
    await configure();
    const provider = { ...baseProvider(), supportsDiscover: false };
    await expect(
      fetchDiscover(deps(provider as unknown as MetadataProvider), "movie", "878", 1),
    ).rejects.toBeInstanceOf(DiscoverUnsupportedError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover.test.ts`
Expected: FAIL — `fetchDiscover` is not exported.

- [ ] **Step 3: Implement `fetchDiscover`**

Append to `discover.ts`:

```ts
export async function fetchDiscover(
  deps: DiscoverDeps,
  type: DiscoverType,
  genreId: string,
  page: number,
): Promise<DiscoverResponse> {
  const { provider, language } = await loadDiscoverProvider(deps);

  const result = await provider.discoverByGenre(
    type,
    genreId,
    page,
    language,
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
  );

  // Upsert so a card opens the detail page with no extra fetch. The ids come
  // back in the same order as the titles, which is the order to render.
  const ids = await upsertTitles(deps.db, result.titles);
  const titles: TitleCard[] = result.titles.map((t, i) => ({
    id: ids[i] as string,
    type: t.type,
    title: t.title,
    year: t.year,
    posterPath: t.posterPath,
  }));

  return { type, genreId, page: result.page, totalPages: result.totalPages, titles };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover.test.ts`
Expected: PASS, 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/metadata/discover.ts apps/server/src/modules/metadata/discover.test.ts
git commit -m "feat(metadata): discover-by-genre proxy service"
```

---

### Task 7: Discover routes

**Files:**
- Modify: `apps/server/src/modules/metadata/routes.ts`
- Create: `apps/server/src/modules/metadata/discover-routes.test.ts`

**Interfaces:**
- Consumes: `fetchGenres`, `fetchDiscover`, `DiscoverUnsupportedError` (Tasks 5–6); `GenreListResponse`, `DiscoverResponse` from `@harbor/shared`.
- Produces: `GET /genres/:type`, `GET /discover/:type/:genreId`.

- [ ] **Step 1: Write the failing tests**

Model on `apps/server/src/modules/metadata/catalog-routes.test.ts` — `createApp` with a fake sql and mocked session, and `vi.mock("./discover.js", ...)` preserving the real `DiscoverUnsupportedError` while mocking `fetchGenres`/`fetchDiscover`. Cover:

```ts
it("requires authentication for genres", async () => {
  const res = await app.inject({ method: "GET", url: `${API_PREFIX}/genres/movie` });
  expect(res.statusCode).toBe(401);
});

it("requires authentication for discover", async () => {
  const res = await app.inject({ method: "GET", url: `${API_PREFIX}/discover/movie/878` });
  expect(res.statusCode).toBe(401);
});

it("rejects an unknown type with 400", async () => {
  const res = await signedInGet("/genres/music");
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe("VALIDATION_FAILED");
});

it("rejects a non-numeric genre id with 400", async () => {
  const res = await signedInGet("/discover/movie/notanumber");
  expect(res.statusCode).toBe(400);
});

it("clamps a page below 1 to 400", async () => {
  const res = await signedInGet("/discover/movie/878?page=0");
  expect(res.statusCode).toBe(400);
});

it("returns genres for a supported type", async () => {
  vi.mocked(fetchGenres).mockResolvedValueOnce({ type: "movie", genres: [{ id: "28", name: "Action" }], cached: false });
  const res = await signedInGet("/genres/movie");
  expect(res.statusCode).toBe(200);
  expect(res.json().genres[0].name).toBe("Action");
});

it("maps DiscoverUnsupportedError to 409 DISCOVER_UNSUPPORTED", async () => {
  vi.mocked(fetchGenres).mockRejectedValueOnce(new DiscoverUnsupportedError("nope"));
  const res = await signedInGet("/genres/movie");
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe("DISCOVER_UNSUPPORTED");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover-routes.test.ts`
Expected: FAIL — 404 for the discover URLs.

- [ ] **Step 3: Add schemas, error mapping, and routes**

At the top of `routes.ts`, extend the shared import and add the discover imports:

```ts
import {
  CATALOG_KINDS,
  type CatalogRowResponse,
  type DiscoverResponse,
  type GenreListResponse,
  type MetadataConfigStatus,
  type SearchResponse,
  type SeasonResponse,
  type TitleDetailResponse,
} from "@harbor/shared";
import { DiscoverUnsupportedError, fetchDiscover, fetchGenres } from "./discover.js";
```

Add the param schemas near `CatalogParamsSchema`:

```ts
const DiscoverTypeSchema = z.enum(["movie", "series"]);
const GenreParamsSchema = z.object({ type: DiscoverTypeSchema });
const DiscoverParamsSchema = z.object({
  type: DiscoverTypeSchema,
  // Numeric string; TMDB genre ids are integers.
  genreId: z.string().regex(/^\d+$/, "Genre id must be numeric."),
});
const DiscoverQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
});
```

Inside `toHarborError`, before the fallthrough:

```ts
  if (error instanceof DiscoverUnsupportedError) {
    // 409: browsing by genre is a real feature this installation's provider
    // cannot offer. The page treats it as unavailable, not an error.
    return new HarborError("DISCOVER_UNSUPPORTED", error.message, 409);
  }
```

Add the routes next to the catalog route (they share `detailRateLimit`):

```ts
  fastify.get("/genres/:type", detailRateLimit, async (request): Promise<GenreListResponse> => {
    const parsed = GenreParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
    }
    try {
      return await fetchGenres(
        { db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET, tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL },
        parsed.data.type,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });

  fastify.get("/discover/:type/:genreId", detailRateLimit, async (request): Promise<DiscoverResponse> => {
    const params = DiscoverParamsSchema.safeParse(request.params);
    const query = DiscoverQuerySchema.safeParse(request.query);
    if (!params.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(params.error), 400);
    }
    if (!query.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(query.error), 400);
    }
    try {
      return await fetchDiscover(
        { db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET, tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL },
        params.data.type,
        params.data.genreId,
        query.data.page,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @harbor/server exec vitest run src/modules/metadata/discover-routes.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the auth guard covers the routes**

Temporarily add `` `GET ${API_PREFIX}/genres/:type` `` to `PUBLIC_ROUTES` in `apps/server/src/plugins/auth.ts`, re-run.
Expected: the "requires authentication for genres" test fails.
Remove the entry.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/routes.ts apps/server/src/modules/metadata/discover-routes.test.ts
git commit -m "feat(metadata): genre and discover endpoints"
```

---

### Task 8: Discover page and live shell nav

**Files:**
- Create: `apps/web/src/discover.ts` (query hooks)
- Create: `apps/web/src/pages/Discover.tsx`
- Create: `apps/web/src/pages/Discover.test.tsx`
- Modify: `apps/web/src/routes.tsx` (add the route)
- Modify: `apps/web/src/components/AppShell.tsx` (Discover becomes a real NavLink)

**Interfaces:**
- Consumes: `request` from `./api-client`; `PosterCard`; `GenreListResponse`, `DiscoverResponse`, `DiscoverType` from `@harbor/shared`; React Aria `Select` primitives; `useSearchParams` from `react-router`.
- Produces: `useGenres(type)`, `useDiscover(type, genreId, page)`, the `Discover` page.

- [ ] **Step 1: Add the query hooks**

`apps/web/src/discover.ts`:

```ts
import type { DiscoverResponse, DiscoverType, GenreListResponse } from "@harbor/shared";
import { useQuery } from "@tanstack/react-query";
import { request } from "./api-client";

export function useGenres(type: DiscoverType) {
  return useQuery({
    queryKey: ["genres", type],
    queryFn: () => request<GenreListResponse>("GET", `/api/v1/genres/${type}`),
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useDiscover(type: DiscoverType, genreId: string | null, page: number) {
  return useQuery({
    queryKey: ["discover", type, genreId, page],
    queryFn: () =>
      request<DiscoverResponse>("GET", `/api/v1/discover/${type}/${genreId ?? ""}?page=${String(page)}`),
    // Only run once a genre is chosen.
    enabled: genreId !== null && genreId !== "",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
```

- [ ] **Step 2: Write the page's failing test**

`apps/web/src/pages/Discover.test.tsx` — mock `../discover` (like `CatalogRow.test.tsx` mocks `../catalog`) and drive states directly. This is a jsdom test with no jest-dom (use plain DOM assertions, as `AppShell.test.tsx` does).

```tsx
import type { DiscoverResponse, GenreListResponse } from "@harbor/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type * as discoverModule from "../discover";
import { Discover } from "./Discover";

const genresState = vi.hoisted(() => ({ current: {} as Partial<UseQueryResult<GenreListResponse>> }));
const discoverState = vi.hoisted(() => ({ current: {} as Partial<UseQueryResult<DiscoverResponse>> }));

vi.mock("../discover", async (importOriginal) => {
  const actual = await importOriginal<typeof discoverModule>();
  return { ...actual, useGenres: () => genresState.current, useDiscover: () => discoverState.current };
});

function renderDiscover(entry = "/discover?type=movie&genre=28"): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: JSX.Element = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(ui);
}

describe("Discover", () => {
  it("renders a poster grid for the selected genre", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: {
        type: "movie",
        genreId: "28",
        page: 1,
        totalPages: 1,
        titles: [{ id: "a", type: "movie", title: "Blade Runner", year: 1982, posterPath: "/p.jpg" }],
      },
    };
    renderDiscover();
    expect(screen.queryByRole("link", { name: /blade runner/i })).not.toBeNull();
  });

  it("shows Load more only when more pages remain", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: { type: "movie", genreId: "28", page: 1, totalPages: 3, titles: [] },
    };
    renderDiscover();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeNull();
  });

  it("hides Load more on the last page", () => {
    genresState.current = { data: { type: "movie", genres: [{ id: "28", name: "Action" }], cached: false } };
    discoverState.current = {
      data: { type: "movie", genreId: "28", page: 3, totalPages: 3, titles: [] },
    };
    renderDiscover();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @harbor/web exec vitest run src/pages/Discover.test.tsx`
Expected: FAIL — cannot resolve `./Discover`.

- [ ] **Step 4: Implement the page**

`apps/web/src/pages/Discover.tsx`. URL is the source of truth: `type` and `genre` in the query string, plus an accumulating page. "Load more" increments a local page count and the grid concatenates pages as they load. Keep the accumulation simple: track loaded pages in state, refetch is per-page via `useDiscover`, and append.

```tsx
import type { DiscoverType, TitleCard } from "@harbor/shared";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDiscover, useGenres } from "../discover";
import { PosterCard } from "../components/PosterCard";
import { ApiError } from "../metadata";

const TYPES: { value: DiscoverType; label: string }[] = [
  { value: "movie", label: "Movies" },
  { value: "series", label: "Series" },
];

function parseType(raw: string | null): DiscoverType {
  return raw === "series" ? "series" : "movie";
}

export function Discover(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const type = parseType(params.get("type"));
  const genre = params.get("genre");

  const genres = useGenres(type);

  // Default the genre to the first in the list once it arrives and none is set.
  useEffect(() => {
    if (genre === null && genres.data && genres.data.genres.length > 0) {
      const next = new URLSearchParams(params);
      next.set("genre", genres.data.genres[0]!.id);
      setParams(next, { replace: true });
    }
  }, [genre, genres.data, params, setParams]);

  // Accumulated pages for the current (type, genre). Reset whenever either
  // changes, so switching genre does not show the previous genre's tail.
  const [maxPage, setMaxPage] = useState(1);
  useEffect(() => {
    setMaxPage(1);
  }, [type, genre]);

  const notConfigured =
    genres.error instanceof ApiError && genres.error.code === "METADATA_NOT_CONFIGURED";
  const unsupported =
    genres.error instanceof ApiError && genres.error.code === "DISCOVER_UNSUPPORTED";

  if (notConfigured || unsupported) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <Alert>
          <AlertDescription>
            {notConfigured ? (
              <>
                Harbor has no metadata provider yet.{" "}
                <Link className="underline" to="/admin/metadata">Configure a metadata provider</Link>.
              </>
            ) : (
              "The configured provider does not support browsing by genre."
            )}
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  function onType(next: DiscoverType): void {
    const p = new URLSearchParams(params);
    p.set("type", next);
    p.delete("genre"); // genres differ per type; let the effect pick the first
    setParams(p);
  }

  function onGenre(id: string): void {
    const p = new URLSearchParams(params);
    p.set("genre", id);
    setParams(p);
  }

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-8">
      <h1 className="font-display text-2xl">Discover</h1>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <div className="flex gap-1 rounded-full bg-card p-1" role="group" aria-label="Type">
          {TYPES.map((t) => (
            <Button
              key={t.value}
              size="sm"
              variant={t.value === type ? "secondary" : "ghost"}
              aria-pressed={t.value === type}
              onPress={() => {
                onType(t.value);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>

        <Select
          aria-label="Genre"
          selectedKey={genre}
          onSelectionChange={(key) => {
            onGenre(String(key));
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectPopover>
            <SelectList className="max-h-80">
              {(genres.data?.genres ?? []).map((g) => (
                <SelectItem key={g.id} id={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectList>
          </SelectPopover>
        </Select>
      </div>

      <DiscoverGrid type={type} genre={genre} maxPage={maxPage} onLoadMore={() => setMaxPage((p) => p + 1)} />
    </main>
  );
}

/** Renders pages 1..maxPage of a genre, concatenated. Each page is its own
 *  query, so React Query caches them independently and Load more only fetches
 *  the new page. */
function DiscoverGrid({
  type,
  genre,
  maxPage,
  onLoadMore,
}: {
  type: DiscoverType;
  genre: string | null;
  maxPage: number;
  onLoadMore: () => void;
}): JSX.Element | null {
  const pages = Array.from({ length: maxPage }, (_, i) => i + 1);
  return (
    <div className="mt-8">
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {pages.map((page) => (
          <DiscoverPage key={page} type={type} genre={genre} page={page} last={page === maxPage} onLoadMore={onLoadMore} />
        ))}
      </ul>
    </div>
  );
}

function DiscoverPage({
  type,
  genre,
  page,
  last,
  onLoadMore,
}: {
  type: DiscoverType;
  genre: string | null;
  page: number;
  last: boolean;
  onLoadMore: () => void;
}): JSX.Element {
  const q = useDiscover(type, genre, page);

  return (
    <>
      {(q.data?.titles ?? []).map((item: TitleCard) => (
        <PosterCard key={item.id} item={item} />
      ))}
      {/* The Load more button belongs to the last rendered page, shown only if
          the provider reports more pages remain. It sits outside the grid via
          a full-row cell so it centres under the grid. */}
      {last && q.data && q.data.page < q.data.totalPages ? (
        <li className="col-span-full mt-4 flex justify-center">
          <Button variant="secondary" onPress={onLoadMore}>
            Load more
          </Button>
        </li>
      ) : null}
      {last && q.data && q.data.titles.length === 0 && page === 1 ? (
        <li className="col-span-full text-sm text-muted-foreground">Nothing in this genre yet.</li>
      ) : null}
    </>
  );
}
```

Note: `PosterCard` renders an `<li>`, so it sits directly inside the `<ul>`. `DiscoverPage` returns a fragment of `<li>` posters plus an optional `<li>` for the button/empty note — all valid `<ul>` children.

- [ ] **Step 5: Run the page test**

Run: `pnpm --filter @harbor/web exec vitest run src/pages/Discover.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Wire the route**

In `apps/web/src/routes.tsx`, add `Discover` to the imports and add a child inside the `AppShell` children array, next to `home`:

```tsx
import { Discover } from "./pages/Discover";
```

```tsx
          { path: "home", Component: Home },
          { path: "discover", Component: Discover },
```

- [ ] **Step 7: Make the shell's Discover nav live**

In `apps/web/src/components/AppShell.tsx`, replace `<ComingSoon label="Discover" />` with:

```tsx
          <NavLink to="/discover" className={linkClass}>
            Discover
          </NavLink>
```

Leave `<ComingSoon label="Library" />` as is (Phase 4).

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint >/dev/null && pnpm typecheck >/dev/null && pnpm build >/dev/null && echo OK`
Expected: `OK`

```bash
git add apps/web/src/discover.ts apps/web/src/pages/Discover.tsx apps/web/src/pages/Discover.test.tsx apps/web/src/routes.tsx apps/web/src/components/AppShell.tsx
git commit -m "feat(web): discover page and live shell nav"
```

---

### Task 9: End-to-end coverage

**Files:**
- Modify: `e2e/scripts/tmdb-fixture.mjs`
- Create: `e2e/tests/07-discover.spec.ts`

**Interfaces:**
- Consumes: the fixture's existing request handler and bearer-token check.
- Produces: fixture routes for genres and discover; a discover spec.

- [ ] **Step 1: Add fixture endpoints**

Before the final 404 in `tmdb-fixture.mjs`'s handler:

```js
if (url.pathname === "/genre/movie/list") {
  send(res, 200, { genres: [{ id: 28, name: "Action" }, { id: 878, name: "Science Fiction" }] });
  return;
}
if (url.pathname === "/genre/tv/list") {
  send(res, 200, { genres: [{ id: 18, name: "Drama" }] });
  return;
}
if (url.pathname === "/discover/movie") {
  // Two pages, so Load more is exercised. media_type omitted, as TMDB does.
  const page = Number(url.searchParams.get("page") ?? "1");
  const results =
    page === 1
      ? [{ id: 78, title: "Blade Runner", poster_path: "/poster.jpg", release_date: "1982-06-25" }]
      : [{ id: 680, title: "Pulp Fiction", poster_path: "/pf.jpg", release_date: "1994-10-14" }];
  send(res, 200, { page, total_pages: 2, results });
  return;
}
if (url.pathname === "/discover/tv") {
  send(res, 200, { page: 1, total_pages: 1, results: [{ id: 1622, name: "Supernatural", poster_path: "/sn.jpg", first_air_date: "2005-09-13" }] });
  return;
}
```

The `/discover/movie` poster is `/poster.jpg`, which the image fixture already serves, so the `naturalWidth` assertion has real bytes.

- [ ] **Step 2: Write the spec**

`e2e/tests/07-discover.spec.ts`, following the `06-home.spec.ts` shared-page pattern (sign in once in `beforeAll`; each test `goto`s):

```ts
import { expect, test, type Page } from "@playwright/test";

const OWNER = { username: "e2eowner", password: "correct-horse-battery-staple" };

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test.afterAll(async () => {
  await page.close();
});

test("the shell nav reaches discover", async () => {
  await page.goto("/home");
  await page.getByRole("link", { name: /^discover$/i }).click();
  await expect(page).toHaveURL(/\/discover/);
  await expect(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
});

test("choosing a genre shows a poster grid", async () => {
  await page.goto("/discover?type=movie&genre=878");
  await expect(page.getByRole("link", { name: /blade runner/i })).toBeVisible();
});

test("posters actually render", async () => {
  await page.goto("/discover?type=movie&genre=878");
  const poster = page.getByRole("link", { name: /blade runner/i }).first().locator("img");
  await expect
    .poll(async () => poster.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth))
    .toBeGreaterThan(0);
});

test("Load more appends the next page", async () => {
  await page.goto("/discover?type=movie&genre=878");
  await expect(page.getByRole("link", { name: /blade runner/i })).toBeVisible();
  await page.getByRole("button", { name: /load more/i }).click();
  await expect(page.getByRole("link", { name: /pulp fiction/i })).toBeVisible();
});

test("switching to series browses tv genres", async () => {
  await page.goto("/discover?type=movie&genre=878");
  await page.getByRole("button", { name: "Series" }).click();
  await expect(page).toHaveURL(/type=series/);
  await expect(page.getByRole("link", { name: /supernatural/i })).toBeVisible();
});

test("discover requires authentication", async ({ browser }) => {
  const anon = await browser.newContext();
  const res = await anon.request.get("/api/v1/discover/movie/878");
  expect(res.status()).toBe(401);
  await anon.close();
});
```

- [ ] **Step 3: Run the suite**

Run: `pnpm test:e2e`
Expected: all specs pass, including the six new ones. The numeric filename prefix matters — `07-discover` depends on `01` creating the owner and `03` configuring the provider.

- [ ] **Step 4: Commit**

```bash
git add e2e/scripts/tmdb-fixture.mjs e2e/tests/07-discover.spec.ts
git commit -m "test(e2e): discover genre browsing"
```

---

### Task 10: Full verification and manual checkpoint

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

Expected: `SMOKE PASSED`. Only this catches a missing Dockerfile `COPY`; `pnpm build` cannot.

- [ ] **Step 3: Deploy for manual review — recreate, never restart**

`docker restart` runs the container against the image it was **created** from, so re-tagging and restarting keeps serving the old build. Recreate:

```bash
docker rm -f harbor-3c2b-app
docker tag harbor:dev harbor:3c2b-live
docker run -d --name harbor-3c2b-app --restart unless-stopped \
  -p 3405:3000 -v harbor_3c2b_data:/data \
  -e DATABASE_URL="postgresql://harbor:harbor@host.docker.internal:55444/harbor_3c2b" \
  -e HARBOR_BASE_URL="http://localhost:3405" \
  -e HARBOR_SECRET="0123456789abcdef0123456789abcdef" \
  -e HARBOR_LOG_LEVEL=warn \
  --add-host host.docker.internal:host-gateway \
  harbor:3c2b-live
```

- [ ] **Step 4: Verify the served bundle is the new one**

```bash
curl -s http://localhost:3405/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Compare against `ls apps/server/public/assets/`. The hashes must match. Never report the app deployed without this check.

- [ ] **Step 5: Hand to the user**

Ask them to confirm at http://localhost:3405: the Discover nav is live; picking a genre shows a grid; the Movies/Series toggle switches genres and results; Load more appends and disappears on the last page; a card opens its title page; the URL reflects type+genre and is shareable.

---

## Self-Review Notes

Checked against the spec:

| Spec requirement | Task |
| --- | --- |
| `DiscoverType`, `Genre`, `GenreListResponse`, `DiscoverResponse`, `DISCOVER_UNSUPPORTED` | 1 |
| `genre_cache` table, one row per type | 2, 3 |
| Genre cache accessors | 3 |
| Provider `supportsDiscover` + `getGenres` + `discoverByGenre`, series→tv, media_type inject | 4 |
| Genre cache-on-read, 7-day TTL, degraded-stale, unauthorized refusal | 5 |
| Discover proxy-through, titles upserted, paging passed through | 6 |
| `GET /genres/:type`, `GET /discover/:type/:genreId?page`, validation, 409 unsupported, auth | 7 |
| Discover page: type toggle, genre picker, grid, Load more, URL-driven; live shell nav | 8 |
| Fixture endpoints, e2e coverage (nav, grid, poster render, load more, type switch, auth) | 9 |
