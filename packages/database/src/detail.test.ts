import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import {
  getSeasonEpisodes,
  getTitleDetail,
  listSeasons,
  replaceEpisodes,
  saveTitleDetail,
} from "./detail.js";
import { runMigrations } from "./migrate.js";
import { upsertTitles } from "./titles.js";

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
  // seasons cascades from titles and episodes from seasons, so truncating
  // titles alone clears the whole tree.
  await db.execute(sql`truncate table titles restart identity cascade`);
});

async function seedTitle(): Promise<string> {
  const ids = await upsertTitles(db, [
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
  return ids[0]!;
}

/** Seasons only reach the database through saveTitleDetail, which writes
 *  them with the title in one transaction. These tests care about the season
 *  rows, so the detail fields are inert filler. */
async function saveSeasons(
  target: Db,
  titleId: string,
  items: Parameters<typeof saveTitleDetail>[3],
): Promise<void> {
  await saveTitleDetail(
    target,
    titleId,
    {
      originalTitle: null,
      year: null,
      overview: null,
      posterPath: null,
      backdropPath: null,
      runtime: null,
      genres: [],
    },
    items,
    new Date(),
  );
}

const SEASON_ONE = {
  seasonNumber: 1,
  name: "Season 1",
  overview: null,
  posterPath: null,
  episodeCount: 22,
  airDate: null,
};

describe("getTitleDetail", () => {
  it("returns null for an unknown id", async () => {
    expect(await getTitleDetail(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  // A title created by search holds only summary fields. A caller must be
  // able to tell that apart from a title whose detail is merely stale.
  it("reports a search-created title as having no detail", async () => {
    const id = await seedTitle();
    const row = await getTitleDetail(db, id);

    expect(row?.detailFetchedAt).toBeNull();
    expect(row?.genres).toEqual([]);
    expect(row?.runtime).toBeNull();
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
      [],
      new Date(),
    );

    const row = await getTitleDetail(db, id);
    expect(row?.runtime).toBe(44);
    expect(row?.genres).toEqual(["Drama", "Mystery"]);
    expect(row?.overview).toBe("Updated overview.");
    expect(row?.backdropPath).toBe("/bd.jpg");
    expect(row?.detailFetchedAt).not.toBeNull();
  });
});

describe("saveTitleDetail seasons and listSeasons", () => {
  it("returns an empty list when nothing is stored", async () => {
    const id = await seedTitle();
    expect(await listSeasons(db, id)).toEqual([]);
  });

  // Ordered by number, not insertion: a tab strip must read 1, 2, 3
  // regardless of the order the provider returned them.
  it("returns seasons in season-number order", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [
      { ...SEASON_ONE, seasonNumber: 3, name: "Season 3" },
      { ...SEASON_ONE, seasonNumber: 2, name: "Season 2" },
      SEASON_ONE,
    ]);

    const rows = await listSeasons(db, id);
    expect(rows.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
  });

  // Providers number specials 0. A naive ascending sort would put them first,
  // so the tab strip would open a show on its specials rather than its first
  // episode -- and the default season, which is simply the first in this
  // list, would be wrong too.
  it("sorts the specials season last, not first", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [
      { ...SEASON_ONE, seasonNumber: 0, name: "Specials" },
      { ...SEASON_ONE, seasonNumber: 2, name: "Season 2" },
      SEASON_ONE,
    ]);

    const rows = await listSeasons(db, id);
    expect(rows.map((s) => s.seasonNumber)).toEqual([1, 2, 0]);
    expect(rows.at(-1)?.name).toBe("Specials");
  });

  it("updates an existing season rather than duplicating it", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);
    await saveSeasons(db, id, [{ ...SEASON_ONE, name: "Renamed", episodeCount: 23 }]);

    const rows = await listSeasons(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Renamed");
    expect(rows[0]?.episodeCount).toBe(23);
  });

  it("keeps seasons of different titles separate", async () => {
    const first = await seedTitle();
    const second = (await upsertTitles(db, [
      {
        type: "series",
        title: "Other Show",
        originalTitle: null,
        year: 2010,
        overview: null,
        posterPath: null,
        backdropPath: null,
        externalIds: [{ source: "tmdb", externalId: "9999" }],
      },
    ]))[0]!;

    await saveSeasons(db, first, [SEASON_ONE]);
    await saveSeasons(db, second, [SEASON_ONE]);

    expect(await listSeasons(db, first)).toHaveLength(1);
    expect(await listSeasons(db, second)).toHaveLength(1);
  });

  it("drops a season the provider no longer lists", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE, { ...SEASON_ONE, seasonNumber: 2, name: "Season 2" }]);
    expect(await listSeasons(db, id)).toHaveLength(2);

    // The provider now reports only season 1. Keeping season 2 would leave a
    // row nothing ever removes, and opening it would ask the provider for a
    // season that does not exist -- a 404, which the degraded path reads as
    // an outage and answers from cache indefinitely.
    await saveSeasons(db, id, [SEASON_ONE]);

    const rows = await listSeasons(db, id);
    expect(rows.map((season) => season.seasonNumber)).toEqual([1]);
  });

  it("does not treat an empty season list as every season being gone", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);

    // A movie has no seasons, and a series whose payload came back empty has
    // told us nothing. Neither is a licence to delete what is already stored.
    await saveSeasons(db, id, []);

    expect(await listSeasons(db, id)).toHaveLength(1);
  });

  it("does not mark a title fresh when its seasons fail to store", async () => {
    const id = await seedTitle();

    // A season number too large for int4 fails on insert. The point is the
    // failure lands mid-write, after the statements that would otherwise have
    // already committed the freshness stamp.
    await expect(
      saveSeasons(db, id, [SEASON_ONE, { ...SEASON_ONE, seasonNumber: 2 ** 40 }]),
    ).rejects.toThrow();

    // Both halves must have rolled back together. A stamped detailFetchedAt
    // here would mean the title is cached as complete while holding a
    // truncated season list, and no refetch happens for the whole TTL.
    const row = await getTitleDetail(db, id);
    expect(row?.detailFetchedAt).toBeNull();
    expect(await listSeasons(db, id)).toHaveLength(0);
  });
});

describe("replaceEpisodes and getSeasonEpisodes", () => {
  it("returns null for a season that was never stored", async () => {
    const id = await seedTitle();
    expect(await getSeasonEpisodes(db, id, 1)).toBeNull();
  });

  it("reports false when the season does not exist", async () => {
    const id = await seedTitle();
    expect(await replaceEpisodes(db, id, 99, [], new Date())).toBe(false);
  });

  it("stores episodes in episode-number order", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);
    await replaceEpisodes(
      db,
      id,
      1,
      [
        { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
        { episodeNumber: 1, name: "Pilot", overview: null, stillPath: "/e1.jpg", runtime: 48, airDate: "2005-09-13" },
      ],
      new Date(),
    );

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.episodes.map((e) => e.episodeNumber)).toEqual([1, 2]);
    expect(result?.episodes[0]?.name).toBe("Pilot");
    expect(result?.episodes[0]?.stillPath).toBe("/e1.jpg");
  });

  // Re-fetching must not accumulate. A provider that drops an episode should
  // drop it here too, rather than leaving a phantom row no refetch removes.
  it("replaces the previous episode set rather than accumulating", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);
    const now = new Date();

    await replaceEpisodes(
      db,
      id,
      1,
      [
        { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
        { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
      ],
      now,
    );
    await replaceEpisodes(
      db,
      id,
      1,
      [{ episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null }],
      now,
    );

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.episodes).toHaveLength(1);
  });

  it("stamps the season's fetchedAt so freshness can be judged", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);

    const before = await getSeasonEpisodes(db, id, 1);
    expect(before?.fetchedAt).toBeNull();

    await replaceEpisodes(db, id, 1, [], new Date());

    const after = await getSeasonEpisodes(db, id, 1);
    expect(after?.fetchedAt).not.toBeNull();
  });

  it("returns the season alongside its episodes", async () => {
    const id = await seedTitle();
    await saveSeasons(db, id, [SEASON_ONE]);
    await replaceEpisodes(db, id, 1, [], new Date());

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.season.seasonNumber).toBe(1);
    expect(result?.season.name).toBe("Season 1");
  });
});
