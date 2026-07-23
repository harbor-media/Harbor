import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "@harbor/crypto";
import {
  closeClient,
  createClient,
  runMigrations,
  saveMetadataProviderConfig,
  upsertTitles,
  type Db,
} from "@harbor/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchSeasonDetail, fetchTitleDetail, TitleNotFoundError } from "./detail.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "drizzle",
);

const HARBOR_SECRET = "0123456789abcdef0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;

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
  await client`truncate table titles, metadata_provider_config restart identity cascade`;
});

async function configure(): Promise<void> {
  await saveMetadataProviderConfig(db, {
    providerId: "tmdb",
    enabled: true,
    encryptedApiKey: encryptSecret("test-key", HARBOR_SECRET),
    language: "en-US",
    lastVerifiedAt: new Date(),
  });
}

async function seedSeries(): Promise<string> {
  const ids = await upsertTitles(db, [
    {
      type: "series",
      title: "Supernatural",
      originalTitle: "Supernatural",
      year: 2005,
      overview: null,
      posterPath: null,
      backdropPath: null,
      externalIds: [{ source: "tmdb", externalId: "1622" }],
    },
  ]);
  return ids[0]!;
}

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
    { seasonNumber: 2, name: "Season 2", overview: null, posterPath: null, episodeCount: 1, airDate: null },
  ],
};

const EPISODES = [
  { episodeNumber: 1, name: "Pilot", overview: null, stillPath: null, runtime: 48, airDate: null },
  { episodeNumber: 2, name: "Wendigo", overview: null, stillPath: null, runtime: 42, airDate: null },
];

interface Calls {
  detail: number;
  season: number;
}

function fakeProvider(calls: Calls): MetadataProvider {
  return {
    id: "tmdb",
    validateConfiguration: async () => undefined,
    search: async () => [],
    getMovie: async () => {
      calls.detail += 1;
      return DETAIL;
    },
    getSeries: async () => {
      calls.detail += 1;
      return DETAIL;
    },
    getSeason: async () => {
      calls.season += 1;
      return EPISODES;
    },
    catalogs: ["trending", "popular-movies", "popular-series", "new-releases"],
    getCatalog: async () => [],
    supportsDiscover: true,
    getGenres: async () => [],
    discoverByGenre: async () => ({ titles: [], page: 1, totalPages: 1 }),
  };
}

function failing(kind: "unavailable" | "unauthorized"): MetadataProvider {
  const boom = (): never => {
    throw new MetadataProviderError(kind, "boom");
  };
  return {
    id: "tmdb",
    validateConfiguration: async () => undefined,
    search: async () => [],
    getMovie: async () => boom(),
    getSeries: async () => boom(),
    getSeason: async () => boom(),
    catalogs: ["trending", "popular-movies", "popular-series", "new-releases"],
    getCatalog: async () => boom(),
    supportsDiscover: true,
    getGenres: async () => boom(),
    discoverByGenre: async () => boom(),
  };
}

const deps = (provider: MetadataProvider, now?: () => Date) => ({
  db,
  harborSecret: HARBOR_SECRET,
  providerFactory: () => provider,
  ...(now ? { now } : {}),
});

describe("fetchTitleDetail", () => {
  it("rejects an unknown title id", async () => {
    await configure();
    await expect(
      fetchTitleDetail(
        { db, harborSecret: HARBOR_SECRET },
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(TitleNotFoundError);
  });

  it("fetches detail for a title known only from search", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };

    const result = await fetchTitleDetail(deps(fakeProvider(calls)), id);

    expect(calls.detail).toBe(1);
    expect(result.cached).toBe(false);
    expect(result.runtime).toBe(44);
    expect(result.genres).toEqual(["Drama"]);
    expect(result.seasons.map((s) => s.seasonNumber)).toEqual([1, 2]);
  });

  // The load-bearing cache assertion: it counts provider calls. Asserting
  // only that data came back would pass whether or not caching works.
  it("serves a second request without contacting the provider", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);

    await fetchTitleDetail(deps(provider), id);
    const second = await fetchTitleDetail(deps(provider), id);

    expect(calls.detail).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.runtime).toBe(44);
  });

  it("refetches once the detail ttl expires", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);

    await fetchTitleDetail(deps(provider), id);
    await fetchTitleDetail(
      deps(provider, () => new Date(Date.now() + DAY_MS + 60_000)),
      id,
    );

    expect(calls.detail).toBe(2);
  });

  // An outage must not blank a page Harbor can already render.
  it("serves stale detail when the provider is unavailable", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    await fetchTitleDetail(deps(fakeProvider(calls)), id);

    const result = await fetchTitleDetail(
      deps(failing("unavailable"), () => new Date(Date.now() + DAY_MS + 60_000)),
      id,
    );

    expect(result.title).toBe("Supernatural");
    expect(result.runtime).toBe(44);
    expect(result.cached).toBe(true);
  });

  // A rejected key is not an outage. Serving stale data over a broken
  // credential hides a problem only an administrator can fix.
  it("does not serve stale detail when the provider rejects the key", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    await fetchTitleDetail(deps(fakeProvider(calls)), id);

    await expect(
      fetchTitleDetail(
        deps(failing("unauthorized"), () => new Date(Date.now() + DAY_MS + 60_000)),
        id,
      ),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rethrows when the provider is unavailable and nothing was ever stored", async () => {
    await configure();
    const id = await seedSeries();

    await expect(
      fetchTitleDetail(deps(failing("unavailable")), id),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });
});

describe("fetchSeasonDetail", () => {
  it("fetches and caches a season's episodes", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);
    await fetchTitleDetail(deps(provider), id);

    const first = await fetchSeasonDetail(deps(provider), id, 1);
    const second = await fetchSeasonDetail(deps(provider), id, 1);

    expect(calls.season).toBe(1);
    expect(first.episodes).toHaveLength(2);
    expect(first.episodes[0]?.name).toBe("Pilot");
    expect(second.cached).toBe(true);
  });

  // The season list comes from the title payload, so a number that is not in
  // it cannot be fetched -- asking the provider would be a wasted round trip
  // for a season that does not exist.
  it("rejects a season number the title does not have", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);
    await fetchTitleDetail(deps(provider), id);

    await expect(fetchSeasonDetail(deps(provider), id, 99)).rejects.toBeInstanceOf(
      TitleNotFoundError,
    );
    expect(calls.season).toBe(0);
  });

  // The season path has the same degraded branch as the title path, and it
  // needs the same two-sided proof: without these, deleting the branch
  // outright -- or widening it to any provider error -- left the suite green.
  it("serves stale episodes when the provider is unavailable", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);
    await fetchTitleDetail(deps(provider), id);
    await fetchSeasonDetail(deps(provider), id, 1);

    const result = await fetchSeasonDetail(
      deps(failing("unavailable"), () => new Date(Date.now() + DAY_MS + 60_000)),
      id,
      1,
    );

    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0]?.name).toBe("Pilot");
    expect(result.cached).toBe(true);
  });

  it("does not serve stale episodes when the provider rejects the key", async () => {
    await configure();
    const id = await seedSeries();
    const calls: Calls = { detail: 0, season: 0 };
    const provider = fakeProvider(calls);
    await fetchTitleDetail(deps(provider), id);
    await fetchSeasonDetail(deps(provider), id, 1);

    await expect(
      fetchSeasonDetail(
        deps(failing("unauthorized"), () => new Date(Date.now() + DAY_MS + 60_000)),
        id,
        1,
      ),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rethrows when the provider is unavailable and no episodes were stored", async () => {
    await configure();
    const id = await seedSeries();
    await fetchTitleDetail(deps(fakeProvider({ detail: 0, season: 0 })), id);

    await expect(
      fetchSeasonDetail(deps(failing("unavailable")), id, 1),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });

  it("rejects an unknown title id", async () => {
    await configure();
    await expect(
      fetchSeasonDetail(
        { db, harborSecret: HARBOR_SECRET },
        "00000000-0000-0000-0000-000000000000",
        1,
      ),
    ).rejects.toBeInstanceOf(TitleNotFoundError);
  });
});
