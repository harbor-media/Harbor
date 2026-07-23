import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "@harbor/crypto";
import { closeClient, createClient, runMigrations, saveMetadataProviderConfig, type Db } from "@harbor/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DiscoverUnsupportedError,
  GENRE_TTL_MS,
  fetchDiscover,
  fetchGenres,
  type DiscoverDeps,
} from "./discover.js";
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
  await client`truncate table titles, metadata_provider_config, genre_cache restart identity cascade`;
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

interface Calls {
  genres: number;
}
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

describe("fetchDiscover", () => {
  const blade = {
    type: "movie" as const,
    title: "Blade Runner",
    originalTitle: null,
    year: 1982,
    overview: null,
    posterPath: "/p.jpg",
    backdropPath: null,
    externalIds: [{ source: "tmdb", externalId: "78" }],
  };

  it("returns the provider's titles as cards, with paging info", async () => {
    await configure();
    const provider = {
      ...baseProvider(),
      discoverByGenre: () => Promise.resolve({ titles: [blade], page: 2, totalPages: 9 }),
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
      discoverByGenre: () => Promise.resolve({ titles: [blade], page: 1, totalPages: 1 }),
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
