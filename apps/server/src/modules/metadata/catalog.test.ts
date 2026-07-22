import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "@harbor/crypto";
import type { NormalizedTitle } from "@harbor/database";
import {
  closeClient,
  createClient,
  runMigrations,
  saveMetadataProviderConfig,
  type Db,
} from "@harbor/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CatalogKindUnsupportedError,
  CATALOG_TTL_MS,
  fetchCatalogRow,
  type CatalogDeps,
} from "./catalog.js";
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
  // catalog_rows is truncated too, so a fetchedAt stamp cannot leak between
  // tests; catalog_entries cascades from both titles and catalog_rows.
  await client`truncate table titles, metadata_provider_config, catalog_rows restart identity cascade`;
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
