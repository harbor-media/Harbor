# Harbor Phase 3c-2a — Title Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make search results clickable, landing on a real title page with artwork, overview, genres, and — for series — season tabs with episodes.

**Architecture:** Three new provider methods feed a detail service that follows the cache-on-read shape 3a established: serve from PostgreSQL when fresh, otherwise fetch, normalize, store, serve. A `detail_fetched_at` marker distinguishes a title Harbor merely knows exists from one it holds in full.

**Tech Stack:** TypeScript 6.0.3, Fastify 5.10.0, Drizzle 0.45.2, Zod 4.4.3, React 19.2.7, shadcn/Radix, Vitest 4.1.10, Playwright 1.61.1.

**Spec:** `docs/superpowers/specs/2026-07-22-harbor-phase-3c2a-title-detail-design.md`

## Global Constraints

- **Never add `Co-Authored-By` trailers, "Generated with Claude Code" footers, or any AI attribution to any commit message or PR body.** Absolute rule.
- Work on the phase branch, never `main`. Confirm with `git branch --show-current` before the first commit of every task.
- `packages/*` and `apps/server` use `nodenext` — relative imports need explicit `.js`. `apps/web` uses `bundler` — extensionless. Mixing breaks the build.
- **The palette is achromatic.** No brand hue. Primary actions use the neutral `primary` token; colour is reserved for the four semantic status values.
- Provider identifiers must never reach the client. Routes take Harbor's own UUID.
- Image paths stay provider-relative; the 3b proxy resolves them. Never build a provider image URL in the frontend.
- No test may contact the real TMDB.
- `no-console` is an ESLint error.
- **Verify with each command gated on its own exit code** — `pnpm lint && echo LINT_OK`. Never pipe through `tail` or `grep`: a pipe replaces the exit status and lets a failure slip past a `&&` chain. This shipped a broken commit in Phase 3b.
- **Adding a package under `packages/` requires a `COPY` line in the `Dockerfile`.** This phase adds none, but if that changes, the Dockerfile changes too.
- Every task ends green on `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/database/src/detail.ts` | Title-detail read/write, season and episode upsert and reads |
| `apps/server/src/modules/metadata/detail.ts` | Detail orchestration: freshness, fetch, store, stale-on-outage |
| `apps/web/src/titles.ts` | Query hooks for the two detail endpoints |
| `apps/web/src/components/TitleHero.tsx` | Backdrop, poster, title, metadata, actions |
| `apps/web/src/components/SeasonTabs.tsx` | Season tab strip |
| `apps/web/src/components/EpisodeList.tsx` | Episode rows with stills |
| `apps/web/src/pages/Title.tsx` | Serves `/movie/:id`, `/series/:id`, `/series/:id/season/:season` |

**Modify:** `packages/database/src/schema.ts` and `index.ts`, `packages/shared/src/index.ts`, `apps/server/src/modules/metadata/providers/{types,tmdb}.ts`, `apps/server/src/modules/metadata/routes.ts`, `apps/web/src/routes.tsx`, `apps/web/src/pages/Search.tsx`.

**The regression net:** 18 Playwright tests plus the server suite. There are still no web unit tests, so Playwright is the only automated proof the frontend works.

---

### Task 1: Schema and migration

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: migration under `packages/database/drizzle/`

**Interfaces:**
- Produces: `titles.runtime`, `titles.genres`, `titles.detailFetchedAt`; tables `seasons`, `episodes`.

- [ ] **Step 1: Extend the schema**

In `packages/database/src/schema.ts`, add three columns to the existing `titles` table definition:

```ts
    runtime: integer("runtime"),
    genres: jsonb("genres").$type<string[]>().notNull().default([]),
    // Distinct from fetchedAt on purpose. A row created by search holds only
    // summary fields; without this there is no way to tell "Harbor knows this
    // title exists" from "Harbor has the whole title", and the detail page
    // would either refetch every visit or render half-empty.
    detailFetchedAt: timestamp("detail_fetched_at", { withTimezone: true, mode: "date" }),
```

Then append the two new tables:

```ts
export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    seasonNumber: integer("season_number").notNull(),
    name: text("name"),
    overview: text("overview"),
    posterPath: text("poster_path"),
    episodeCount: integer("episode_count"),
    airDate: text("air_date"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [uniqueIndex("seasons_title_number_idx").on(t.titleId, t.seasonNumber)],
);

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    episodeNumber: integer("episode_number").notNull(),
    name: text("name"),
    overview: text("overview"),
    stillPath: text("still_path"),
    runtime: integer("runtime"),
    airDate: text("air_date"),
  },
  (t) => [uniqueIndex("episodes_season_number_idx").on(t.seasonId, t.episodeNumber)],
);
```

`airDate` is `text`, not `date`: provider payloads carry `""` for unknown dates as often as `null`, and a text column stores that faithfully instead of failing the insert.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @harbor/database exec drizzle-kit generate`
Expected: a new `packages/database/drizzle/0006_*.sql`.

- [ ] **Step 3: Inspect the SQL**

Open the generated file. Confirm it only ADDs columns and CREATEs tables and indexes. Any `DROP` against an existing table or column means the generator misread the schema — stop and report rather than applying it.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @harbor/database test && echo DB_OK`
Expected: PASS. The migration test drops and recreates the schema, so it exercises the new migration.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle
git commit -m "feat(database): season, episode, and title detail schema"
```

---

### Task 2: Detail accessors

**Files:**
- Create: `packages/database/src/detail.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/detail.test.ts`

**Interfaces:**
- Consumes: `Db`, `titles`, `seasons`, `episodes`, `titleExternalIds`; `StoredTitle` and `TitleType` from `./titles.js`.
- Produces:
  - `interface NormalizedSeason { seasonNumber: number; name: string | null; overview: string | null; posterPath: string | null; episodeCount: number | null; airDate: string | null }`
  - `interface NormalizedEpisode { episodeNumber: number; name: string | null; overview: string | null; stillPath: string | null; runtime: number | null; airDate: string | null }`
  - `interface StoredTitleDetail extends StoredTitle { runtime: number | null; genres: string[]; detailFetchedAt: Date | null }`
  - `interface TitleDetailUpdate { originalTitle: string | null; year: number | null; overview: string | null; posterPath: string | null; backdropPath: string | null; runtime: number | null; genres: string[] }`
  - `getTitleDetail(db: Db, id: string): Promise<StoredTitleDetail | null>`
  - `saveTitleDetail(db: Db, id: string, update: TitleDetailUpdate, now: Date): Promise<void>`
  - `upsertSeasons(db: Db, titleId: string, items: NormalizedSeason[]): Promise<void>`
  - `listSeasons(db: Db, titleId: string): Promise<NormalizedSeason[]>`
  - `replaceEpisodes(db: Db, titleId: string, seasonNumber: number, items: NormalizedEpisode[], now: Date): Promise<boolean>`
  - `getSeasonEpisodes(db: Db, titleId: string, seasonNumber: number): Promise<{ season: NormalizedSeason; episodes: NormalizedEpisode[]; fetchedAt: Date | null } | null>`

- [ ] **Step 1: Write the failing tests**

`packages/database/src/detail.test.ts` — reuse the Testcontainers `beforeAll`/`afterAll`/`beforeEach` scaffolding from `packages/database/src/titles.test.ts`, truncating `episodes, seasons, title_external_ids, titles` between tests.

```ts
import { describe, expect, it } from "vitest";
import { upsertTitles } from "./titles.js";
import {
  getSeasonEpisodes,
  getTitleDetail,
  listSeasons,
  replaceEpisodes,
  saveTitleDetail,
  upsertSeasons,
} from "./detail.js";

async function seedTitle(): Promise<string> {
  const [id] = await upsertTitles(db, [
    {
      type: "series",
      title: "Supernatural",
      originalTitle: "Supernatural",
      year: 2005,
      overview: "Two brothers hunt monsters.",
      posterPath: "/sn.jpg",
      backdropPath: null,
      externalIds: [{ source: "tmdb", externalId: "1622" }],
    },
  ]);
  return id!;
}

describe("getTitleDetail", () => {
  it("returns null for an unknown id", async () => {
    expect(await getTitleDetail(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  // A title created by search has no detail yet. The caller must be able to
  // tell that apart from a title whose detail is merely stale.
  it("reports a search-created title as having no detail", async () => {
    const id = await seedTitle();
    const row = await getTitleDetail(db, id);
    expect(row?.detailFetchedAt).toBeNull();
    expect(row?.genres).toEqual([]);
  });

  it("exposes the external ids so a caller can reach the provider", async () => {
    const id = await seedTitle();
    const row = await getTitleDetail(db, id);
    expect(row?.externalIds).toContainEqual({ source: "tmdb", externalId: "1622" });
  });
});

describe("saveTitleDetail", () => {
  it("stores detail fields and stamps detailFetchedAt", async () => {
    const id = await seedTitle();
    const when = new Date();

    await saveTitleDetail(
      db,
      id,
      {
        originalTitle: "Supernatural",
        year: 2005,
        overview: "Updated overview.",
        posterPath: "/sn2.jpg",
        backdropPath: "/bd.jpg",
        runtime: 44,
        genres: ["Drama", "Mystery"],
      },
      when,
    );

    const row = await getTitleDetail(db, id);
    expect(row?.runtime).toBe(44);
    expect(row?.genres).toEqual(["Drama", "Mystery"]);
    expect(row?.overview).toBe("Updated overview.");
    expect(row?.detailFetchedAt).not.toBeNull();
  });
});

describe("upsertSeasons / listSeasons", () => {
  it("stores seasons and returns them in season order", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [
      { seasonNumber: 2, name: "Season 2", overview: null, posterPath: null, episodeCount: 22, airDate: "2006-09-28" },
      { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 22, airDate: "2005-09-13" },
    ]);

    const rows = await listSeasons(db, id);
    // Ordered by number, not insertion: the tab strip must read 1, 2, 3.
    expect(rows.map((s) => s.seasonNumber)).toEqual([1, 2]);
  });

  it("updates an existing season rather than duplicating it", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [
      { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 22, airDate: null },
    ]);
    await upsertSeasons(db, id, [
      { seasonNumber: 1, name: "Renamed", overview: null, posterPath: null, episodeCount: 23, airDate: null },
    ]);

    const rows = await listSeasons(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
    expect(rows[0]?.episodeCount).toBe(23);
  });
});

describe("replaceEpisodes / getSeasonEpisodes", () => {
  it("returns null for a season that was never stored", async () => {
    const id = await seedTitle();
    expect(await getSeasonEpisodes(db, id, 1)).toBeNull();
  });

  it("stores episodes in episode order", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [
      { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 3, airDate: null },
    ]);
    await replaceEpisodes(
      db,
      id,
      1,
      [
        { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
        { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
      ],
      new Date(),
    );

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.episodes.map((e) => e.episodeNumber)).toEqual([1, 2]);
    expect(result?.episodes[0]?.name).toBe("Pilot");
  });

  // Re-fetching must not accumulate. A show that drops a special episode
  // should lose it here too, rather than keeping a phantom row forever.
  it("replaces the previous episode set rather than accumulating", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [
      { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 2, airDate: null },
    ]);
    const now = new Date();
    await replaceEpisodes(db, id, 1, [
      { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
      { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
    ], now);
    await replaceEpisodes(db, id, 1, [
      { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
    ], now);

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.episodes).toHaveLength(1);
  });

  it("reports false when the season does not exist", async () => {
    const id = await seedTitle();
    expect(await replaceEpisodes(db, id, 99, [], new Date())).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @harbor/database test detail`
Expected: FAIL — cannot resolve `./detail.js`.

- [ ] **Step 3: Implement**

`packages/database/src/detail.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { episodes, seasons, titleExternalIds, titles } from "./schema.js";
import type { StoredTitle, TitleExternalId } from "./titles.js";

export interface NormalizedSeason {
  seasonNumber: number;
  name: string | null;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number | null;
  airDate: string | null;
}

export interface NormalizedEpisode {
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  runtime: number | null;
  airDate: string | null;
}

export interface StoredTitleDetail extends StoredTitle {
  runtime: number | null;
  genres: string[];
  detailFetchedAt: Date | null;
}

export interface TitleDetailUpdate {
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  genres: string[];
}

export async function getTitleDetail(db: Db, id: string): Promise<StoredTitleDetail | null> {
  const rows = await db.select().from(titles).where(eq(titles.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const externals = await db
    .select()
    .from(titleExternalIds)
    .where(eq(titleExternalIds.titleId, id));

  const externalIds: TitleExternalId[] = externals.map((e) => ({
    source: e.source,
    externalId: e.externalId,
  }));

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    originalTitle: row.originalTitle,
    year: row.year,
    overview: row.overview,
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    runtime: row.runtime,
    genres: row.genres,
    detailFetchedAt: row.detailFetchedAt,
    externalIds,
  };
}

export async function saveTitleDetail(
  db: Db,
  id: string,
  update: TitleDetailUpdate,
  now: Date,
): Promise<void> {
  await db
    .update(titles)
    .set({
      originalTitle: update.originalTitle,
      year: update.year,
      overview: update.overview,
      posterPath: update.posterPath,
      backdropPath: update.backdropPath,
      runtime: update.runtime,
      genres: update.genres,
      detailFetchedAt: now,
      fetchedAt: now,
    })
    .where(eq(titles.id, id));
}

export async function upsertSeasons(
  db: Db,
  titleId: string,
  items: NormalizedSeason[],
): Promise<void> {
  if (items.length === 0) return;

  for (const item of items) {
    await db
      .insert(seasons)
      .values({
        titleId,
        seasonNumber: item.seasonNumber,
        name: item.name,
        overview: item.overview,
        posterPath: item.posterPath,
        episodeCount: item.episodeCount,
        airDate: item.airDate,
      })
      .onConflictDoUpdate({
        target: [seasons.titleId, seasons.seasonNumber],
        set: {
          name: item.name,
          overview: item.overview,
          posterPath: item.posterPath,
          episodeCount: item.episodeCount,
          airDate: item.airDate,
        },
      });
  }
}

export async function listSeasons(db: Db, titleId: string): Promise<NormalizedSeason[]> {
  const rows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.titleId, titleId))
    // Ordered by number: a tab strip must read 1, 2, 3 regardless of the
    // order the provider returned them or the order they were inserted.
    .orderBy(asc(seasons.seasonNumber));

  return rows.map((r) => ({
    seasonNumber: r.seasonNumber,
    name: r.name,
    overview: r.overview,
    posterPath: r.posterPath,
    episodeCount: r.episodeCount,
    airDate: r.airDate,
  }));
}

/**
 * Replaces a season's episodes wholesale. Returns false when the season row
 * does not exist.
 *
 * Delete-then-insert rather than upsert: a provider that drops an episode
 * should drop it here too. An upsert would leave a phantom row that no
 * refetch ever removes.
 */
export async function replaceEpisodes(
  db: Db,
  titleId: string,
  seasonNumber: number,
  items: NormalizedEpisode[],
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.titleId, titleId), eq(seasons.seasonNumber, seasonNumber)))
      .limit(1);

    const season = found[0];
    if (!season) return false;

    await tx.delete(episodes).where(eq(episodes.seasonId, season.id));

    if (items.length > 0) {
      await tx.insert(episodes).values(
        items.map((item) => ({
          seasonId: season.id,
          episodeNumber: item.episodeNumber,
          name: item.name,
          overview: item.overview,
          stillPath: item.stillPath,
          runtime: item.runtime,
          airDate: item.airDate,
        })),
      );
    }

    await tx.update(seasons).set({ fetchedAt: now }).where(eq(seasons.id, season.id));
    return true;
  });
}

export async function getSeasonEpisodes(
  db: Db,
  titleId: string,
  seasonNumber: number,
): Promise<{ season: NormalizedSeason; episodes: NormalizedEpisode[]; fetchedAt: Date | null } | null> {
  const found = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.titleId, titleId), eq(seasons.seasonNumber, seasonNumber)))
    .limit(1);

  const season = found[0];
  if (!season) return null;

  const rows = await db
    .select()
    .from(episodes)
    .where(eq(episodes.seasonId, season.id))
    .orderBy(asc(episodes.episodeNumber));

  return {
    season: {
      seasonNumber: season.seasonNumber,
      name: season.name,
      overview: season.overview,
      posterPath: season.posterPath,
      episodeCount: season.episodeCount,
      airDate: season.airDate,
    },
    episodes: rows.map((r) => ({
      episodeNumber: r.episodeNumber,
      name: r.name,
      overview: r.overview,
      stillPath: r.stillPath,
      runtime: r.runtime,
      airDate: r.airDate,
    })),
    fetchedAt: season.fetchedAt,
  };
}
```

- [ ] **Step 4: Export it**

Add `export * from "./detail.js";` to `packages/database/src/index.ts`, keeping the list alphabetical.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/database test && echo DB_OK`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/detail.ts packages/database/src/detail.test.ts packages/database/src/index.ts
git commit -m "feat(database): title detail, season, and episode accessors"
```

---

### Task 3: Provider detail methods

**Files:**
- Modify: `apps/server/src/modules/metadata/providers/types.ts`, `apps/server/src/modules/metadata/providers/tmdb.ts`
- Test: `apps/server/src/modules/metadata/providers/tmdb-detail.test.ts`

**Interfaces:**
- Consumes: `NormalizedSeason`, `NormalizedEpisode` from `@harbor/database`.
- Produces, added to `MetadataProvider`:
  - `interface ProviderTitleDetail { originalTitle: string | null; year: number | null; overview: string | null; posterPath: string | null; backdropPath: string | null; runtime: number | null; genres: string[]; seasons: NormalizedSeason[] }`
  - `getMovie(externalId: string, language: string, signal: AbortSignal): Promise<ProviderTitleDetail>`
  - `getSeries(externalId: string, language: string, signal: AbortSignal): Promise<ProviderTitleDetail>`
  - `getSeason(externalId: string, seasonNumber: number, language: string, signal: AbortSignal): Promise<NormalizedEpisode[]>`

`getEpisode` is deliberately absent — TMDB's season endpoint returns the whole episode list, so per-episode fetching would issue more requests for the same data.

- [ ] **Step 1: Extend the contract**

In `apps/server/src/modules/metadata/providers/types.ts`, add the interface and three method signatures to `MetadataProvider`, and replace the stale comment about the four detail methods with one noting that `getEpisode` alone remains unimplemented and why.

- [ ] **Step 2: Write the failing tests**

`apps/server/src/modules/metadata/providers/tmdb-detail.test.ts`. Model the fake-fetch helpers on the existing `tmdb.test.ts`.

```ts
import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fake(impl: () => Promise<Response>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

const SIGNAL = (): AbortSignal => AbortSignal.timeout(5000);

const MOVIE = {
  id: 78,
  title: "Blade Runner",
  original_title: "Blade Runner",
  release_date: "1982-06-25",
  overview: "A blade runner must pursue replicants.",
  poster_path: "/poster.jpg",
  backdrop_path: "/backdrop.jpg",
  runtime: 117,
  genres: [{ id: 878, name: "Science Fiction" }, { id: 53, name: "Thriller" }],
};

const SERIES = {
  id: 1622,
  name: "Supernatural",
  original_name: "Supernatural",
  first_air_date: "2005-09-13",
  overview: "Two brothers hunt monsters.",
  poster_path: "/sn.jpg",
  backdrop_path: null,
  episode_run_time: [44],
  genres: [{ id: 18, name: "Drama" }],
  seasons: [
    { season_number: 0, name: "Specials", overview: "", poster_path: null, episode_count: 5, air_date: null },
    { season_number: 1, name: "Season 1", overview: "", poster_path: "/s1.jpg", episode_count: 22, air_date: "2005-09-13" },
  ],
};

const SEASON = {
  season_number: 1,
  episodes: [
    { episode_number: 1, name: "Pilot", overview: "Sam and Dean.", still_path: "/e1.jpg", runtime: 48, air_date: "2005-09-13" },
    { episode_number: 2, name: "Wendigo", overview: "", still_path: null, runtime: 42, air_date: "2005-09-20" },
  ],
};

describe("getMovie", () => {
  it("normalizes a movie payload", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(MOVIE)) });
    const detail = await provider.getMovie("78", "en-US", SIGNAL());

    expect(detail.runtime).toBe(117);
    expect(detail.year).toBe(1982);
    expect(detail.genres).toEqual(["Science Fiction", "Thriller"]);
    expect(detail.backdropPath).toBe("/backdrop.jpg");
    // A movie has no seasons; the field exists so callers need no type test.
    expect(detail.seasons).toEqual([]);
  });

  it("maps a 404 to a not-found style failure", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json({}, 404)) });
    await expect(provider.getMovie("0", "en-US", SIGNAL())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("getSeries", () => {
  it("normalizes a series payload including its seasons", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(SERIES)) });
    const detail = await provider.getSeries("1622", "en-US", SIGNAL());

    expect(detail.year).toBe(2005);
    expect(detail.genres).toEqual(["Drama"]);
    // episode_run_time is an array; the first entry is the representative one.
    expect(detail.runtime).toBe(44);
    expect(detail.seasons.map((s) => s.seasonNumber)).toEqual([0, 1]);
    expect(detail.seasons[1]?.episodeCount).toBe(22);
  });

  it("tolerates an empty episode_run_time", async () => {
    const provider = createTmdbProvider("key", {
      fetchImpl: fake(async () => json({ ...SERIES, episode_run_time: [] })),
    });
    const detail = await provider.getSeries("1622", "en-US", SIGNAL());
    expect(detail.runtime).toBeNull();
  });
});

describe("getSeason", () => {
  it("normalizes episodes", async () => {
    const provider = createTmdbProvider("key", { fetchImpl: fake(async () => json(SEASON)) });
    const eps = await provider.getSeason("1622", 1, "en-US", SIGNAL());

    expect(eps).toHaveLength(2);
    expect(eps[0]).toEqual({
      episodeNumber: 1,
      name: "Pilot",
      overview: "Sam and Dean.",
      stillPath: "/e1.jpg",
      runtime: 48,
      airDate: "2005-09-13",
    });
  });

  it("requests the season path for the given number", async () => {
    const fetchImpl = vi.fn(async () => json(SEASON));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.getSeason("1622", 3, "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/tv/1622/season/3");
  });

  it("never puts the api key in the url", async () => {
    const fetchImpl = vi.fn(async () => json(SEASON));
    const provider = createTmdbProvider("super-secret", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getSeason("1622", 1, "en-US", SIGNAL());
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("super-secret");
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm --filter @harbor/server test tmdb-detail`
Expected: FAIL — the methods do not exist.

- [ ] **Step 4: Implement**

In `apps/server/src/modules/metadata/providers/tmdb.ts`, reuse the existing private `call()` helper — it already sends the key as a bearer header, refuses redirects, and maps failures. Add the three methods to the returned object, plus normalizers:

```ts
interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbSeasonSummary {
  season_number: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  episode_count?: number;
  air_date?: string | null;
}

interface TmdbEpisode {
  episode_number: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  runtime?: number | null;
  air_date?: string | null;
}

/** Provider payloads use "" for unknown dates as often as null. */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function toDetail(payload: Record<string, unknown>, isMovie: boolean): ProviderTitleDetail {
  const genres = (payload["genres"] as TmdbGenre[] | undefined) ?? [];
  const runTimes = (payload["episode_run_time"] as number[] | undefined) ?? [];
  const seasonList = (payload["seasons"] as TmdbSeasonSummary[] | undefined) ?? [];

  return {
    originalTitle: textOrNull(
      (isMovie ? payload["original_title"] : payload["original_name"]) as string | undefined,
    ),
    year: yearOf(
      (isMovie ? payload["release_date"] : payload["first_air_date"]) as string | undefined,
    ),
    overview: textOrNull(payload["overview"] as string | undefined),
    posterPath: textOrNull(payload["poster_path"] as string | null | undefined),
    backdropPath: textOrNull(payload["backdrop_path"] as string | null | undefined),
    runtime: isMovie
      ? ((payload["runtime"] as number | undefined) ?? null)
      : (runTimes[0] ?? null),
    genres: genres.map((g) => g.name),
    seasons: isMovie
      ? []
      : seasonList.map((s) => ({
          seasonNumber: s.season_number,
          name: textOrNull(s.name),
          overview: textOrNull(s.overview),
          posterPath: textOrNull(s.poster_path),
          episodeCount: s.episode_count ?? null,
          airDate: textOrNull(s.air_date),
        })),
  };
}
```

and the methods:

```ts
    async getMovie(externalId, language, signal) {
      const payload = (await call(
        `/movie/${externalId}`,
        new URLSearchParams({ language }),
        signal,
      )) as Record<string, unknown>;
      return toDetail(payload, true);
    },

    async getSeries(externalId, language, signal) {
      const payload = (await call(
        `/tv/${externalId}`,
        new URLSearchParams({ language }),
        signal,
      )) as Record<string, unknown>;
      return toDetail(payload, false);
    },

    async getSeason(externalId, seasonNumber, language, signal) {
      const payload = (await call(
        `/tv/${externalId}/season/${String(seasonNumber)}`,
        new URLSearchParams({ language }),
        signal,
      )) as { episodes?: TmdbEpisode[] };

      return (payload.episodes ?? []).map((e) => ({
        episodeNumber: e.episode_number,
        name: textOrNull(e.name),
        overview: textOrNull(e.overview),
        stillPath: textOrNull(e.still_path),
        runtime: e.runtime ?? null,
        airDate: textOrNull(e.air_date),
      }));
    },
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/server test tmdb && echo TMDB_OK`
Expected: PASS — the existing search tests plus the new detail tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/providers
git commit -m "feat(metadata): provider methods for movie, series, and season detail"
```

---

### Task 4: Shared DTOs

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `SeasonSummary`, `EpisodeItem`, `TitleDetailResponse`, `SeasonResponse`.

No new error codes: the detail endpoints reuse `METADATA_NOT_CONFIGURED`, `METADATA_PROVIDER_UNAVAILABLE`, `METADATA_PROVIDER_UNAUTHORIZED`, `METADATA_KEY_UNREADABLE`, and `NOT_FOUND`, so the frontend's existing `describeMetadataError` keeps working unchanged.

- [ ] **Step 1: Add the DTOs**

Append to `packages/shared/src/index.ts`:

```ts
export interface SeasonSummary {
  seasonNumber: number;
  name: string | null;
  episodeCount: number | null;
  posterPath: string | null;
  airDate: string | null;
}

export interface EpisodeItem {
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  runtime: number | null;
  airDate: string | null;
}

export interface TitleDetailResponse {
  id: string;
  type: "movie" | "series";
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  genres: string[];
  /** Empty for movies. Season summaries only — episodes come from the
   *  season endpoint, so drawing a tab strip does not fetch a whole show. */
  seasons: SeasonSummary[];
  /** True when served without contacting the provider. */
  cached: boolean;
}

export interface SeasonResponse {
  seasonNumber: number;
  name: string | null;
  overview: string | null;
  episodes: EpisodeItem[];
  cached: boolean;
}
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter @harbor/shared test && echo SHARED_OK && pnpm typecheck && echo TYPECHECK_OK`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): title detail and season DTOs"
```

---

### Task 5: Detail service

**Files:**
- Create: `apps/server/src/modules/metadata/detail.ts`
- Test: `apps/server/src/modules/metadata/detail.test.ts`

**Interfaces:**
- Consumes: `loadProvider` from `./config.js`; the Task 2 accessors; `MetadataProviderError`.
- Produces:
  - `const DETAIL_TTL_MS = 86_400_000`
  - `class TitleNotFoundError extends Error`
  - `interface DetailDeps { db: Db; harborSecret: string; now?: () => Date; providerFactory?: (apiKey: string) => MetadataProvider; tmdbBaseUrl?: string }`
  - `fetchTitleDetail(deps: DetailDeps, titleId: string): Promise<TitleDetailResponse>`
  - `fetchSeasonDetail(deps: DetailDeps, titleId: string, seasonNumber: number): Promise<SeasonResponse>`

- [ ] **Step 1: Write the failing tests**

`apps/server/src/modules/metadata/detail.test.ts` — reuse the Testcontainers scaffolding and the `configure()` helper pattern from `apps/server/src/modules/metadata/search.test.ts`, which stores an encrypted provider key.

```ts
import { describe, expect, it, vi } from "vitest";
import { upsertTitles } from "@harbor/database";
import { fetchSeasonDetail, fetchTitleDetail, TitleNotFoundError } from "./detail.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

const DETAIL = {
  originalTitle: "Supernatural",
  year: 2005,
  overview: "Two brothers hunt monsters.",
  posterPath: "/sn.jpg",
  backdropPath: "/bd.jpg",
  runtime: 44,
  genres: ["Drama"],
  seasons: [
    { seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 2, airDate: null },
  ],
};

const EPISODES = [
  { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
  { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
];

function provider(calls: { detail: number; season: number }): MetadataProvider {
  return {
    id: "tmdb",
    validateConfiguration: async () => undefined,
    search: async () => [],
    getMovie: async () => {
      calls.detail += 1;
      return DETAIL as never;
    },
    getSeries: async () => {
      calls.detail += 1;
      return DETAIL as never;
    },
    getSeason: async () => {
      calls.season += 1;
      return EPISODES as never;
    },
  } as unknown as MetadataProvider;
}

describe("fetchTitleDetail", () => {
  it("rejects an unknown title id", async () => {
    await expect(
      fetchTitleDetail({ db, harborSecret: SECRET }, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(TitleNotFoundError);
  });

  it("fetches detail for a title known only from search", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };

    const result = await fetchTitleDetail(
      { db, harborSecret: SECRET, providerFactory: () => provider(calls) },
      id,
    );

    expect(calls.detail).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.runtime).toBe(44);
    expect(result.seasons.map((s) => s.seasonNumber)).toEqual([1]);
  });

  // The load-bearing cache assertion: it counts provider calls. Asserting
  // only that data came back would pass whether or not caching works.
  it("serves a second request without contacting the provider", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };
    const deps = { db, harborSecret: SECRET, providerFactory: () => provider(calls) };

    await fetchTitleDetail(deps, id);
    const second = await fetchTitleDetail(deps, id);

    expect(calls.detail).toBe(1);
    expect(second.cached).toBe(true);
  });

  it("refetches once the detail ttl expires", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };

    await fetchTitleDetail({ db, harborSecret: SECRET, providerFactory: () => provider(calls) }, id);
    await fetchTitleDetail(
      {
        db,
        harborSecret: SECRET,
        providerFactory: () => provider(calls),
        now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
      },
      id,
    );

    expect(calls.detail).toBe(2);
  });

  // An outage must not blank a page Harbor can already render.
  it("serves stale detail when the provider is unavailable", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };
    await fetchTitleDetail({ db, harborSecret: SECRET, providerFactory: () => provider(calls) }, id);

    const failing = {
      ...provider(calls),
      getSeries: async () => {
        throw new MetadataProviderError("unavailable", "down");
      },
    } as unknown as MetadataProvider;

    const result = await fetchTitleDetail(
      {
        db,
        harborSecret: SECRET,
        providerFactory: () => failing,
        now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
      },
      id,
    );

    expect(result.title).toBe("Supernatural");
    expect(result.cached).toBe(true);
  });

  it("rethrows when the provider is unavailable and no detail was ever stored", async () => {
    await configure(db);
    const id = await seedSeries();
    const failing = {
      id: "tmdb",
      validateConfiguration: async () => undefined,
      search: async () => [],
      getSeries: async () => {
        throw new MetadataProviderError("unavailable", "down");
      },
    } as unknown as MetadataProvider;

    await expect(
      fetchTitleDetail({ db, harborSecret: SECRET, providerFactory: () => failing }, id),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });
});

describe("fetchSeasonDetail", () => {
  it("fetches and caches a season's episodes", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };
    const deps = { db, harborSecret: SECRET, providerFactory: () => provider(calls) };

    const first = await fetchSeasonDetail(deps, id, 1);
    const second = await fetchSeasonDetail(deps, id, 1);

    expect(calls.season).toBe(1);
    expect(first.episodes).toHaveLength(2);
    expect(second.cached).toBe(true);
  });

  it("rejects a season that does not exist on the title", async () => {
    await configure(db);
    const id = await seedSeries();
    const calls = { detail: 0, season: 0 };

    await expect(
      fetchSeasonDetail({ db, harborSecret: SECRET, providerFactory: () => provider(calls) }, id, 99),
    ).rejects.toBeInstanceOf(TitleNotFoundError);
  });
});
```

Add a `seedSeries()` helper that inserts a series title via `upsertTitles` with a `tmdb` external id and returns its id, and a `SECRET` constant matching `search.test.ts`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @harbor/server test metadata/detail`
Expected: FAIL — cannot resolve `./detail.js`.

- [ ] **Step 3: Implement**

`apps/server/src/modules/metadata/detail.ts`. The service must:

1. `getTitleDetail(db, titleId)`; throw `TitleNotFoundError` when null.
2. Treat detail as fresh when `detailFetchedAt` is non-null and within `DETAIL_TTL_MS` of `now()`. Fresh means: build the response from stored data and `listSeasons`, with `cached: true`, **and make no provider call**.
3. Otherwise load the provider, pick `getMovie` or `getSeries` by `title.type`, using the `tmdb` external id.
4. On success: `saveTitleDetail`, `upsertSeasons` for a series, then read back and respond with `cached: false`.
5. On `MetadataProviderError` of kind `unavailable`: if `detailFetchedAt` is non-null, serve the stored data with `cached: true`; otherwise rethrow. Any other kind rethrows immediately — an outage justifies stale data, a rejected key does not.
6. `fetchSeasonDetail` mirrors this against `getSeasonEpisodes` and the season's own `fetchedAt`, calling `replaceEpisodes` on a fetch. A season number absent from the `seasons` table throws `TitleNotFoundError` rather than fetching, since the season list comes from the title payload.

The provider timeout is 15 seconds, matching the search service.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/server test metadata/detail && echo DETAIL_OK`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the cache assertion is load-bearing**

Temporarily change the freshness check so it always treats detail as stale, and re-run. The "serves a second request without contacting the provider" test must FAIL. Restore it, confirm green, and report both results. A cache test that passes with caching disabled is worthless.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/detail.ts apps/server/src/modules/metadata/detail.test.ts
git commit -m "feat(metadata): title and season detail with cache-on-read"
```

---

### Task 6: Detail routes

**Files:**
- Modify: `apps/server/src/modules/metadata/routes.ts`
- Test: `apps/server/src/modules/metadata/detail-routes.test.ts`

**Interfaces:**
- Consumes: `fetchTitleDetail`, `fetchSeasonDetail`, `TitleNotFoundError`; the existing `toHarborError` in `routes.ts`.

- [ ] **Step 1: Add the routes**

In `apps/server/src/modules/metadata/routes.ts`, extend `toHarborError` to map `TitleNotFoundError` to `new HarborError("NOT_FOUND", "Title not found.", 404)`, then add:

```ts
  const TitleParamsSchema = z.object({ id: z.uuid() });
  const SeasonParamsSchema = z.object({
    id: z.uuid(),
    season: z.coerce.number().int().min(0).max(1000),
  });
```

and two `fastify.get` handlers on `/titles/:id` and `/titles/:id/seasons/:season`, each parsing params with the schema above, calling the matching service function with `{ db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET, tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL }`, and wrapping failures in `toHarborError`. Rate limit both at `max: 120, timeWindow: "1 minute"` — a title page issues one detail request plus one per season tab, so the search endpoint's 60 is too tight.

Both routes require authentication. Do **not** add them to `PUBLIC_ROUTES`.

- [ ] **Step 2: Write the route tests**

`apps/server/src/modules/metadata/detail-routes.test.ts` — follow the mocked-session setup in `apps/server/src/modules/images/routes.test.ts`, which mocks `findSessionByTokenHash` to return a signed-in user. Define `API_PREFIX` (imported from `@harbor/shared`), `SESSION_COOKIE` (from `../auth/cookies.js`), a `USER_TOKEN` string, and a `UUID` constant holding any valid UUID — these tests exercise auth and validation, so the id need not exist.

```ts
import { describe, expect, it } from "vitest";

describe("detail routes", () => {
  it("requires authentication for a title", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/titles/${UUID}` });
    expect(res.statusCode).toBe(401);
  });

  it("requires authentication for a season", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/titles/${UUID}/seasons/1` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-uuid title id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/not-a-uuid`,
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a negative season number", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/-1`,
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports an unconfigured provider distinctly, not as a server error", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}`,
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect([404, 409]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(500);
  });
});
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @harbor/server test && echo SERVER_OK && pnpm lint && echo LINT_OK && pnpm typecheck && echo TYPECHECK_OK`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/metadata/routes.ts apps/server/src/modules/metadata/detail-routes.test.ts
git commit -m "feat(metadata): title and season detail routes"
```

---

### Task 7: Web client and the title hero

**Files:**
- Create: `apps/web/src/titles.ts`, `apps/web/src/components/TitleHero.tsx`, `apps/web/src/pages/Title.tsx`
- Modify: `apps/web/src/routes.tsx`

Remember: `apps/web` uses **extensionless** imports.

**Interfaces:**
- Consumes: `TitleDetailResponse`, `SeasonResponse` from `@harbor/shared`; `imageUrl` from `../images`; `ApiError` and `describeMetadataError` from `../metadata`.
- Produces: `useTitleDetail(id)`, `useSeasonDetail(id, season)`; `TitleHero`; routes `/movie/:id`, `/series/:id`, `/series/:id/season/:season`.

- [ ] **Step 1: Write the query hooks**

`apps/web/src/titles.ts`. Mirror the request helper and `ApiError` handling already in `apps/web/src/metadata.ts` so error codes survive to the UI:

```ts
export function useTitleDetail(id: string) — GET /api/v1/titles/${id}
export function useSeasonDetail(id: string, season: number | null) — GET /api/v1/titles/${id}/seasons/${season}, enabled only when season !== null
```

Both use a `staleTime` of five minutes and `refetchOnWindowFocus: false`, matching `useSearch`.

- [ ] **Step 2: Build the hero**

`apps/web/src/components/TitleHero.tsx`. Requirements:

- Backdrop from `imageUrl(backdropPath, "w780")`. **When it is null, fall back to `imageUrl(posterPath, "w780")` rendered blurred and darkened.** When both are null, render the flat canvas. This fallback is the point of the component — provider backdrops are frequently missing, so the degraded case is common, not rare.
- A gradient from transparent to `background` over the lower portion so the backdrop fades into the page rather than ending in a hard edge.
- Poster from `imageUrl(posterPath, "w342")` in a fixed box, overlapping the backdrop's lower edge, with a neutral placeholder box of identical dimensions when absent.
- Title as an `<h1>`, then a metadata line joining year, runtime in minutes, and type with `·` separators, skipping absent values so no stray separators appear.
- Genres as `Badge` components.
- A primary `Button` reading `Play` and a secondary reading `Watchlist`. **Both are inert in this phase** — playback is Phase 5 and the library is Phase 4. Give each `disabled` and a `title` attribute explaining it is not available yet, rather than wiring a handler that does nothing.
- Every image needs an `alt`; the poster's is `Poster for <title>`, matching the convention `Search.tsx` already uses.

- [ ] **Step 3: Build the page**

`apps/web/src/pages/Title.tsx` serves all three routes. It reads `:id` from params, and `:season` when present. Requirements:

- While loading, render a skeleton that reserves the hero's exact height so the page does not jump when artwork arrives.
- On error, render an `Alert variant="destructive"` with `describeMetadataError`, and for `METADATA_NOT_CONFIGURED` link to `/admin/metadata` — matching what `Search.tsx` does.
- For a movie, render hero and overview only.
- For a series, render hero, overview, then the season tabs and episode list from Task 8.

- [ ] **Step 4: Add the routes**

In `apps/web/src/routes.tsx`, add `movie/:id`, `series/:id`, and `series/:id/season/:season`, all inside the authenticated section alongside `search`.

- [ ] **Step 5: Verify**

Run: `pnpm lint && echo LINT_OK && pnpm typecheck && echo TYPECHECK_OK && pnpm --filter @harbor/web build && echo WEB_OK`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/titles.ts apps/web/src/components/TitleHero.tsx apps/web/src/pages/Title.tsx apps/web/src/routes.tsx
git commit -m "feat(web): title detail page with cinematic hero"
```

---

### Task 8: Season tabs and episodes

**Files:**
- Create: `apps/web/src/components/SeasonTabs.tsx`, `apps/web/src/components/EpisodeList.tsx`
- Modify: `apps/web/src/pages/Title.tsx`

**Interfaces:**
- Consumes: `SeasonSummary`, `EpisodeItem` from `@harbor/shared`; `useSeasonDetail`; `imageUrl`.

- [ ] **Step 1: Build the tabs**

`apps/web/src/components/SeasonTabs.tsx`. Requirements:

- Render one tab per `SeasonSummary`, labelled by `name` when present and `Season <n>` otherwise.
- Each tab is a **`<Link>` to `/series/:id/season/:n`**, not a button. Seasons must stay linkable and the back button must work, which is why the spec put a season in the URL at all.
- Mark the active tab with `aria-current="page"` and the neutral `primary` token as an underline. No brand hue.
- The strip scrolls horizontally when seasons overflow, with `overflow-x-auto`. A twenty-season show must not break the layout.

- [ ] **Step 2: Build the episode list**

`apps/web/src/components/EpisodeList.tsx`. Requirements:

- One row per episode: number, still, name, and a line joining runtime and air date with `·`, skipping absent values.
- Still from `imageUrl(stillPath, "w185")` in a fixed box, with a neutral placeholder of identical dimensions when absent, so rows do not reflow as images load.
- `loading="lazy"` on every still — a 22-episode season is 22 image requests.
- Each still's `alt` is the episode name, or `Episode <n>` when the name is absent.
- When the list is empty, render a plain "No episodes listed for this season." rather than an empty container.

- [ ] **Step 3: Wire them into the page**

In `Title.tsx`, for a series: render `SeasonTabs` from `detail.seasons`, resolve the active season from the `:season` param — defaulting to the **first season in the list** when the route has none — and render `EpisodeList` from `useSeasonDetail`.

- [ ] **Step 4: Verify**

Run: `pnpm lint && echo LINT_OK && pnpm typecheck && echo TYPECHECK_OK && pnpm --filter @harbor/web build && echo WEB_OK`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components apps/web/src/pages/Title.tsx
git commit -m "feat(web): season tabs and episode list"
```

---

### Task 9: Make search results clickable

**Files:**
- Modify: `apps/web/src/pages/Search.tsx`

- [ ] **Step 1: Link each result**

Wrap each result row in a `<Link>` to `/movie/${item.id}` or `/series/${item.id}`, chosen by `item.type`.

**Do not change any existing text, label, role, or the poster's alt text.** `03-metadata.spec.ts` and `04-images.spec.ts` match on `getByLabel("Title")`, the button named `Search`, the `role="status"` cache line, the poster alt `Poster for <title>`, and the TMDB attribution string. A wrapping link must leave all of those reachable.

Keep the fixed 70×105 poster box and the frontend-rendered placeholder.

- [ ] **Step 2: Verify**

Run: `pnpm lint && echo LINT_OK && pnpm typecheck && echo TYPECHECK_OK && pnpm build && echo BUILD_OK && pnpm test:e2e`
Expected: PASS, 18 e2e passed. Docker must be running; say so rather than skipping.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/Search.tsx
git commit -m "feat(web): link search results to their title pages"
```

---

### Task 10: End-to-end coverage, docs, and the checkpoint

**Files:**
- Create: `e2e/tests/05-title-detail.spec.ts`, `docs/catalog.md`
- Modify: `e2e/scripts/tmdb-fixture.mjs`

- [ ] **Step 1: Extend the metadata fixture**

`e2e/scripts/tmdb-fixture.mjs` currently answers `/authentication` and `/search/multi`. Add `/movie/:id`, `/tv/:id`, and `/tv/:id/season/:n`, returning payloads shaped like the ones in Task 3's tests — the series must have at least two seasons so a tab switch is observable. Keep the bearer-token check that already guards the fixture.

- [ ] **Step 2: Write the spec**

`e2e/tests/05-title-detail.spec.ts`. The numeric prefix is load-bearing: the suite shares one database serially and this spec depends on `01` creating the owner and `03` configuring the provider.

Cover:
1. Search, click a result, and land on a title page showing the title as a heading.
2. The page shows genres and an overview.
3. For a series, season tabs are present; clicking the second tab changes the URL to `/season/2` and shows different episode names.
4. Reloading a title page still shows it — served from Harbor's cache — and the fixture's request count does not increase. Add a `/count` endpoint to the fixture as `image-fixture.mjs` already does.
5. An unauthenticated request to `/api/v1/titles/<uuid>` returns 401.

Query the fixture's counter through Playwright's **Node-side** `page.request`, not `page.evaluate` — Harbor's CSP sets `connect-src 'self'`, so a page-side fetch to the fixture origin is blocked.

- [ ] **Step 3: Write the documentation**

`docs/catalog.md` covering: the three routes, that `:id` is Harbor's UUID and provider ids never reach the client, the 24-hour detail TTL and what a stale-but-cached page means during an outage, why episodes come only from the season endpoint, and that Play and Watchlist are inert until Phases 5 and 4. Link it from `docs/metadata.md`.

- [ ] **Step 4: Full verification**

```bash
pnpm lint && echo LINT_OK
pnpm typecheck && echo TYPECHECK_OK
pnpm test && echo TESTS_OK
pnpm build && echo BUILD_OK
pnpm test:e2e
```

Each gated on its own exit code — never piped.

- [ ] **Step 5: Verify the Docker image**

```bash
docker build -t harbor:3c2a-verify .
HARBOR_IMAGE=harbor:3c2a-verify SMOKE_PORT=3562 bash scripts/smoke.sh
```

Expected: build succeeds, `SMOKE PASSED`. Mandatory — Phase 3a passed every workspace check and still shipped a broken image, because `pnpm build` does not exercise the Dockerfile.

- [ ] **Step 6: Commit**

```bash
git add e2e docs/catalog.md docs/metadata.md
git commit -m "test(e2e): title detail journey and season navigation"
```

- [ ] **Step 7: Stop for manual testing**

Start a local instance and hand it to the user. They will configure a TMDB key, search, click a result, and check: the hero renders with artwork, a title with no backdrop still looks right (the blurred-poster fallback), genres and overview appear, season tabs switch episodes, and the back button returns to the previous season.

Do not proceed to the final review until the user confirms.

---

## Definition of Done

- [ ] Search results link to `/movie/:id` or `/series/:id` by type
- [ ] A title page renders artwork, overview, genres, runtime, and year
- [ ] A missing backdrop falls back to the blurred poster, not a flat bar
- [ ] Series show season tabs; each tab is a link to `/series/:id/season/:n`
- [ ] Episodes load one season at a time, never all seasons at once
- [ ] A second visit is served from cache, proven by asserting no provider call
- [ ] Detail refetches after 24 hours
- [ ] A provider outage serves stale detail; a rejected key does not
- [ ] Re-fetching a season replaces its episodes rather than accumulating them
- [ ] Provider ids never reach the client; routes take Harbor UUIDs
- [ ] Both endpoints require authentication
- [ ] Play and Watchlist are visibly inert rather than dead handlers
- [ ] All existing Playwright tests still pass unchanged
- [ ] The Docker image builds and the container smoke test passes
- [ ] No commit carries an AI attribution trailer
