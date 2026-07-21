import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import { getMetadataProviderConfig, saveMetadataProviderConfig } from "./metadata.js";

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
  await db.execute(sql`truncate table metadata_provider_config`);
});

describe("metadata provider config", () => {
  it("returns null when no provider is configured", async () => {
    expect(await getMetadataProviderConfig(db, "tmdb")).toBeNull();
  });

  it("saves and reads back a configuration", async () => {
    const verifiedAt = new Date();
    await saveMetadataProviderConfig(db, {
      providerId: "tmdb",
      enabled: true,
      encryptedApiKey: "v1:aaa:bbb:ccc",
      language: "en-US",
      lastVerifiedAt: verifiedAt,
    });

    const row = await getMetadataProviderConfig(db, "tmdb");
    expect(row?.enabled).toBe(true);
    expect(row?.encryptedApiKey).toBe("v1:aaa:bbb:ccc");
    expect(row?.language).toBe("en-US");
  });

  // Re-saving must replace, not accumulate: the provider row is a singleton
  // per provider and a second insert would violate the primary key.
  it("overwrites an existing configuration", async () => {
    await saveMetadataProviderConfig(db, {
      providerId: "tmdb",
      enabled: true,
      encryptedApiKey: "v1:first",
      language: "en-US",
      lastVerifiedAt: new Date(),
    });
    await saveMetadataProviderConfig(db, {
      providerId: "tmdb",
      enabled: false,
      encryptedApiKey: "v1:second",
      language: "da-DK",
      lastVerifiedAt: new Date(),
    });

    const row = await getMetadataProviderConfig(db, "tmdb");
    expect(row?.encryptedApiKey).toBe("v1:second");
    expect(row?.enabled).toBe(false);
    expect(row?.language).toBe("da-DK");
  });
});
