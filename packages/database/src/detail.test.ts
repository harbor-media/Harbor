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
  upsertSeasons,
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

describe("upsertSeasons and listSeasons", () => {
  it("returns an empty list when nothing is stored", async () => {
    const id = await seedTitle();
    expect(await listSeasons(db, id)).toEqual([]);
  });

  // Ordered by number, not insertion: a tab strip must read 1, 2, 3
  // regardless of the order the provider returned them.
  it("returns seasons in season-number order", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [
      { ...SEASON_ONE, seasonNumber: 2, name: "Season 2" },
      { ...SEASON_ONE, seasonNumber: 0, name: "Specials" },
      SEASON_ONE,
    ]);

    const rows = await listSeasons(db, id);
    expect(rows.map((s) => s.seasonNumber)).toEqual([0, 1, 2]);
  });

  it("updates an existing season rather than duplicating it", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [SEASON_ONE]);
    await upsertSeasons(db, id, [{ ...SEASON_ONE, name: "Renamed", episodeCount: 23 }]);

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

    await upsertSeasons(db, first, [SEASON_ONE]);
    await upsertSeasons(db, second, [SEASON_ONE]);

    expect(await listSeasons(db, first)).toHaveLength(1);
    expect(await listSeasons(db, second)).toHaveLength(1);
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
    await upsertSeasons(db, id, [SEASON_ONE]);
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
    await upsertSeasons(db, id, [SEASON_ONE]);
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
    await upsertSeasons(db, id, [SEASON_ONE]);

    const before = await getSeasonEpisodes(db, id, 1);
    expect(before?.fetchedAt).toBeNull();

    await replaceEpisodes(db, id, 1, [], new Date());

    const after = await getSeasonEpisodes(db, id, 1);
    expect(after?.fetchedAt).not.toBeNull();
  });

  it("returns the season alongside its episodes", async () => {
    const id = await seedTitle();
    await upsertSeasons(db, id, [SEASON_ONE]);
    await replaceEpisodes(db, id, 1, [], new Date());

    const result = await getSeasonEpisodes(db, id, 1);
    expect(result?.season.seasonNumber).toBe(1);
    expect(result?.season.name).toBe("Season 1");
  });
});
