import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeClient,
  createClient,
  runMigrations,
  saveMetadataProviderConfig,
  type Db,
} from "@harbor/database";
import { encryptSecret } from "@harbor/crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";
import { searchTitles } from "./search.js";

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
  // Truncate every table this suite touches between tests -- several cases
  // depend on the cache being empty or populated in a specific state, so
  // leftovers from a prior test would silently change what gets exercised.
  await client`truncate table metadata_search_cache, title_external_ids, titles, metadata_provider_config restart identity cascade`;
});

function fakeProvider(results: unknown[], calls: { count: number }): MetadataProvider {
  return {
    id: "tmdb",
    validateConfiguration: async () => undefined,
    search: async () => {
      calls.count += 1;
      return results as never;
    },
  };
}

const BLADE_RUNNER = {
  type: "movie" as const,
  title: "Blade Runner",
  originalTitle: "Blade Runner",
  year: 1982,
  overview: "A blade runner must pursue replicants.",
  posterPath: "/poster.jpg",
  backdropPath: "/backdrop.jpg",
  externalIds: [{ source: "tmdb" as const, externalId: "78" }],
};

async function configure(db: Db): Promise<void> {
  await saveMetadataProviderConfig(db, {
    providerId: "tmdb",
    enabled: true,
    encryptedApiKey: encryptSecret("test-key", HARBOR_SECRET),
    language: "en-US",
    lastVerifiedAt: new Date(),
  });
}

describe("searchTitles", () => {
  it("queries the provider on a cold cache and reports cached: false", async () => {
    await configure(db);
    const calls = { count: 0 };

    const response = await searchTitles(
      { db, harborSecret: HARBOR_SECRET, providerFactory: () => fakeProvider([BLADE_RUNNER], calls) },
      "blade runner",
    );

    expect(calls.count).toBe(1);
    expect(response.cached).toBe(false);
    expect(response.results[0]?.title).toBe("Blade Runner");
  });

  // The load-bearing cache assertion: it checks that NO outbound call
  // happened. Asserting only that results came back would pass whether or
  // not caching works at all.
  it("serves a repeat search from cache without calling the provider", async () => {
    await configure(db);
    const calls = { count: 0 };
    const deps = {
      db,
      harborSecret: HARBOR_SECRET,
      providerFactory: () => fakeProvider([BLADE_RUNNER], calls),
    };

    await searchTitles(deps, "blade runner cached");
    const second = await searchTitles(deps, "blade runner cached");

    expect(calls.count).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.results[0]?.title).toBe("Blade Runner");
  });

  it("normalizes query casing and whitespace so they share a cache entry", async () => {
    await configure(db);
    const calls = { count: 0 };
    const deps = {
      db,
      harborSecret: HARBOR_SECRET,
      providerFactory: () => fakeProvider([BLADE_RUNNER], calls),
    };

    await searchTitles(deps, "Casing Test");
    await searchTitles(deps, "  casing test  ");

    expect(calls.count).toBe(1);
  });

  it("falls back to cached results when the provider is unavailable", async () => {
    await configure(db);
    const calls = { count: 0 };

    await searchTitles(
      { db, harborSecret: HARBOR_SECRET, providerFactory: () => fakeProvider([BLADE_RUNNER], calls) },
      "fallback test",
    );

    const failing: MetadataProvider = {
      id: "tmdb",
      validateConfiguration: async () => undefined,
      search: async () => {
        throw new MetadataProviderError("unavailable", "down");
      },
    };

    // Force a cache miss by expiring the entry, then confirm the stale rows
    // are still served rather than the request failing outright.
    const response = await searchTitles(
      {
        db,
        harborSecret: HARBOR_SECRET,
        providerFactory: () => failing,
        now: () => new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
      "fallback test",
    );

    expect(response.results[0]?.title).toBe("Blade Runner");
    expect(response.cached).toBe(true);
  });

  it("rethrows when the provider is unavailable and nothing is cached", async () => {
    await configure(db);
    const failing: MetadataProvider = {
      id: "tmdb",
      validateConfiguration: async () => undefined,
      search: async () => {
        throw new MetadataProviderError("unavailable", "down");
      },
    };

    await expect(
      searchTitles({ db, harborSecret: HARBOR_SECRET, providerFactory: () => failing }, "nothing cached"),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });
});
