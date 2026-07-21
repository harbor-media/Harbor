# Harbor Phase 3a — Metadata Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Harbor an encrypted-at-rest TMDB credential, a provider-agnostic metadata adapter, and a remote-first search that caches its results, so an administrator can configure a key and search real titles.

**Architecture:** A new `@harbor/crypto` package encrypts provider credentials with AES-256-GCM under a key derived from `HARBOR_SECRET`. A `MetadataProvider` adapter normalizes TMDB responses into Harbor DTOs at the boundary, so nothing TMDB-shaped reaches the domain. Search queries the provider, upserts normalized rows into Harbor's own tables, and serves repeat queries from PostgreSQL within a one-hour TTL.

**Tech Stack:** TypeScript 6.0.3, Fastify 5.10.0, Drizzle 0.45.2, Zod 4.4.3, node:crypto, React 19.2.7, Vitest 4.1.10, Playwright 1.61.1.

**Spec:** `docs/superpowers/specs/2026-07-21-harbor-phase-3a-metadata-foundation-design.md`

## Global Constraints

- **Never add `Co-Authored-By` trailers, "Generated with Claude Code" footers, or any AI attribution to any commit message or PR body.** This is an absolute rule.
- Work on the phase branch, never on `main`. Confirm the branch with `git branch --show-current` before the first commit of every task.
- `packages/*` and `apps/server` use `moduleResolution: nodenext` — **all relative imports need explicit `.js` extensions.** `apps/web` uses `bundler` — extensionless imports. Mixing these breaks the build.
- The plaintext TMDB API key must never appear in an API response, a log line, or a frontend bundle. Not masked, not truncated.
- `no-console` is an error in ESLint. Use the injected logger.
- Root `eslint.config.js` and `turbo.json` already cover any new `packages/*` workspace. No registration step is needed.
- Every task ends green on `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Readiness (`/api/v1/health/ready`) must never fail because TMDB is unreachable.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/crypto/src/index.ts` | AES-256-GCM encrypt/decrypt of provider secrets, HKDF key derivation |
| `packages/database/src/metadata.ts` | Read/write the provider config row |
| `packages/database/src/titles.ts` | Upsert canonical titles and external IDs; read titles by ID in order |
| `packages/database/src/search-cache.ts` | Read/write the search-result cache |
| `apps/server/src/modules/metadata/providers/types.ts` | `MetadataProvider` contract, DTOs, `MetadataProviderError` |
| `apps/server/src/modules/metadata/providers/tmdb.ts` | TMDB adapter and response normalization |
| `apps/server/src/modules/metadata/config.ts` | Load the decrypted key and build a provider |
| `apps/server/src/modules/metadata/search.ts` | Remote-first, cache-on-read search orchestration |
| `apps/server/src/modules/metadata/routes.ts` | Admin config routes and the search route |
| `apps/web/src/pages/AdminMetadata.tsx` | Admin configuration page |
| `apps/web/src/pages/Search.tsx` | Throwaway pipeline-proof search scaffolding |

**Modify:** `packages/shared/src/index.ts` (error codes, DTOs), `packages/database/src/schema.ts` and `index.ts`, `apps/server/src/app.ts` (route registration), `apps/web/src/routes.tsx`.

---

### Task 1: `@harbor/crypto` — authenticated secret encryption

**Files:**
- Create: `packages/crypto/package.json`, `packages/crypto/tsconfig.json`, `packages/crypto/vitest.config.ts`, `packages/crypto/src/index.ts`
- Test: `packages/crypto/src/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encryptSecret(plaintext: string, harborSecret: string): string`, `decryptSecret(envelope: string, harborSecret: string): string`, `class SecretDecryptionError extends Error`.

- [ ] **Step 1: Create the package manifest**

`packages/crypto/package.json`:

```json
{
  "name": "@harbor/crypto",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`packages/crypto/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/crypto/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {},
});
```

- [ ] **Step 2: Write the failing tests**

`packages/crypto/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, SecretDecryptionError } from "./index.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(decryptSecret(envelope, SECRET)).toBe("tmdb-api-key-value");
  });

  it("never emits the plaintext inside the envelope", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(envelope).not.toContain("tmdb-api-key-value");
    expect(envelope.startsWith("v1:")).toBe(true);
  });

  // A random IV per encryption is what stops two identical keys producing
  // identical ciphertext, which would leak that two installs share a key.
  it("produces different ciphertext for the same plaintext", () => {
    const a = encryptSecret("same-value", SECRET);
    const b = encryptSecret("same-value", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe(decryptSecret(b, SECRET));
  });

  // Rotating HARBOR_SECRET must fail loudly, not silently yield garbage or
  // report the credential as absent.
  it("refuses to decrypt under a different secret", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(() => decryptSecret(envelope, OTHER_SECRET)).toThrow(SecretDecryptionError);
  });

  // The GCM auth tag is the whole point of choosing GCM: a hand-edited or
  // corrupted database row must be detected rather than decrypted to junk.
  it("detects tampered ciphertext", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    const parts = envelope.split(":");
    const ciphertext = Buffer.from(parts[3]!, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    parts[3] = ciphertext.toString("base64");
    expect(() => decryptSecret(parts.join(":"), SECRET)).toThrow(SecretDecryptionError);
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope", SECRET)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("v2:a:b:c", SECRET)).toThrow(SecretDecryptionError);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm --filter @harbor/crypto test`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 4: Implement**

`packages/crypto/src/index.ts`:

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// HARBOR_SECRET is a general-purpose installation secret. It is never used
// directly as an encryption key: HKDF derives a key bound to this specific
// purpose, so a future use of HARBOR_SECRET elsewhere cannot produce a
// colliding key. The info string carries a version so the derivation can
// change without ambiguity about which key decrypts an old value.
const HKDF_INFO = "harbor:provider-credentials:v1";
const HKDF_SALT = "harbor-provider-credentials";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

function deriveKey(harborSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", harborSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export function encryptSecret(plaintext: string, harborSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(harborSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(envelope: string, harborSecret: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError("Stored credential is not a recognized envelope.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(harborSecret),
      Buffer.from(parts[1]!, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // The underlying error is deliberately not chained: it can carry key
    // material context, and callers only need to know the credential is
    // unusable and must be re-entered.
    throw new SecretDecryptionError(
      "Stored credential could not be decrypted. If HARBOR_SECRET changed, re-enter the provider key.",
    );
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/crypto test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Install and verify the workspace picks up the package**

Run: `pnpm install && pnpm lint && pnpm typecheck`
Expected: all green; `@harbor/crypto` appears in the task list.

- [ ] **Step 7: Commit**

```bash
git add packages/crypto
git commit -m "feat(crypto): AES-256-GCM encryption for provider credentials"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/database/src/schema.ts`
- Create: migration under `packages/database/drizzle/`

**Interfaces:**
- Produces: tables `metadata_provider_config`, `titles`, `title_external_ids`, `metadata_search_cache`; enums `title_type`, `external_id_source`.

- [ ] **Step 1: Add the schema**

Append to `packages/database/src/schema.ts` (the `pgEnum`, `index`, `uniqueIndex`, `integer`, `jsonb` imports may need extending — add `jsonb` and `primaryKey` to the existing import block from `drizzle-orm/pg-core`):

```ts
export const titleType = pgEnum("title_type", ["movie", "series"]);

export const externalIdSource = pgEnum("external_id_source", ["tmdb", "imdb"]);

export const metadataProviderConfig = pgTable("metadata_provider_config", {
  providerId: text("provider_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  encryptedApiKey: text("encrypted_api_key"),
  language: text("language").notNull().default("en-US"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const titles = pgTable(
  "titles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: titleType("type").notNull(),
    title: text("title").notNull(),
    originalTitle: text("original_title"),
    year: integer("year"),
    overview: text("overview"),
    posterPath: text("poster_path"),
    backdropPath: text("backdrop_path"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("titles_title_idx").on(t.title)],
);

export const titleExternalIds = pgTable(
  "title_external_ids",
  {
    titleId: uuid("title_id")
      .notNull()
      .references(() => titles.id, { onDelete: "cascade" }),
    source: externalIdSource("source").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [
    // The natural key for a title. Upserts target this, never the display
    // title -- two films can share a name and must stay distinct rows.
    uniqueIndex("title_external_ids_source_external_idx").on(t.source, t.externalId),
    index("title_external_ids_title_idx").on(t.titleId),
  ],
);

export const metadataSearchCache = pgTable(
  "metadata_search_cache",
  {
    queryHash: text("query_hash").notNull(),
    language: text("language").notNull(),
    // Ordered: this array IS the provider's relevance ranking. Anything that
    // reads it must preserve order.
    titleIds: jsonb("title_ids").$type<string[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.queryHash, t.language] })],
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @harbor/database exec drizzle-kit generate`
Expected: a new `packages/database/drizzle/0005_*.sql` is written.

- [ ] **Step 3: Inspect the generated SQL**

Open the new file. Confirm it only **creates** enums, tables, and indexes — it must contain no `DROP` against an existing table or column. If it does, stop and report: destructive migrations against existing data are forbidden.

- [ ] **Step 4: Verify it applies**

Run: `pnpm --filter @harbor/database test`
Expected: PASS. The migration test drops and recreates the schema, so this exercises the new migration.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts packages/database/drizzle
git commit -m "feat(database): metadata provider config, titles, and search cache schema"
```

---

### Task 3: Provider-config accessors

**Files:**
- Create: `packages/database/src/metadata.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/metadata.test.ts`

**Interfaces:**
- Consumes: `Db` from `./client.js`; `metadataProviderConfig` from `./schema.js`.
- Produces:
  - `interface MetadataProviderConfigRow { providerId: string; enabled: boolean; encryptedApiKey: string | null; language: string; lastVerifiedAt: Date | null }`
  - `getMetadataProviderConfig(db: Db, providerId: string): Promise<MetadataProviderConfigRow | null>`
  - `saveMetadataProviderConfig(db: Db, input: { providerId: string; enabled: boolean; encryptedApiKey: string; language: string; lastVerifiedAt: Date }): Promise<void>`

- [ ] **Step 1: Write the failing test**

`packages/database/src/metadata.test.ts` — follow the existing connection setup in `packages/database/src/invitations.test.ts` for `beforeAll`/`afterAll` and the `DATABASE_URL` guard; mirror that file's structure exactly.

```ts
import { describe, expect, it } from "vitest";
import { getMetadataProviderConfig, saveMetadataProviderConfig } from "./metadata.js";

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @harbor/database test metadata`
Expected: FAIL — cannot resolve `./metadata.js`.

- [ ] **Step 3: Implement**

`packages/database/src/metadata.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { metadataProviderConfig } from "./schema.js";

export interface MetadataProviderConfigRow {
  providerId: string;
  enabled: boolean;
  encryptedApiKey: string | null;
  language: string;
  lastVerifiedAt: Date | null;
}

export interface SaveMetadataProviderConfigInput {
  providerId: string;
  enabled: boolean;
  encryptedApiKey: string;
  language: string;
  lastVerifiedAt: Date;
}

export async function getMetadataProviderConfig(
  db: Db,
  providerId: string,
): Promise<MetadataProviderConfigRow | null> {
  const rows = await db
    .select()
    .from(metadataProviderConfig)
    .where(eq(metadataProviderConfig.providerId, providerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    providerId: row.providerId,
    enabled: row.enabled,
    encryptedApiKey: row.encryptedApiKey,
    language: row.language,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export async function saveMetadataProviderConfig(
  db: Db,
  input: SaveMetadataProviderConfigInput,
): Promise<void> {
  await db
    .insert(metadataProviderConfig)
    .values({
      providerId: input.providerId,
      enabled: input.enabled,
      encryptedApiKey: input.encryptedApiKey,
      language: input.language,
      lastVerifiedAt: input.lastVerifiedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: metadataProviderConfig.providerId,
      set: {
        enabled: input.enabled,
        encryptedApiKey: input.encryptedApiKey,
        language: input.language,
        lastVerifiedAt: input.lastVerifiedAt,
        updatedAt: new Date(),
      },
    });
}
```

- [ ] **Step 4: Export it**

Add to `packages/database/src/index.ts`, keeping the list alphabetical:

```ts
export * from "./metadata.js";
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/database test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/metadata.ts packages/database/src/metadata.test.ts packages/database/src/index.ts
git commit -m "feat(database): provider configuration accessors"
```

---

### Task 4: Title upsert and ordered read

**Files:**
- Create: `packages/database/src/titles.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/titles.test.ts`

**Interfaces:**
- Produces:
  - `type TitleType = "movie" | "series"`
  - `type ExternalIdSource = "tmdb" | "imdb"`
  - `interface NormalizedTitle { type: TitleType; title: string; originalTitle: string | null; year: number | null; overview: string | null; posterPath: string | null; backdropPath: string | null; externalIds: { source: ExternalIdSource; externalId: string }[] }`
  - `interface StoredTitle extends NormalizedTitle { id: string }`
  - `upsertTitles(db: Db, items: NormalizedTitle[]): Promise<string[]>` — returns IDs **in input order**
  - `getTitlesByIds(db: Db, ids: string[]): Promise<StoredTitle[]>` — returns rows **in the order of `ids`**

- [ ] **Step 1: Write the failing test**

`packages/database/src/titles.test.ts` — reuse the `beforeAll`/`afterAll` connection setup from `packages/database/src/invitations.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { getTitlesByIds, upsertTitles, type NormalizedTitle } from "./titles.js";

function title(overrides: Partial<NormalizedTitle> & { externalId: string }): NormalizedTitle {
  const { externalId, ...rest } = overrides;
  return {
    type: "movie",
    title: "Blade Runner",
    originalTitle: "Blade Runner",
    year: 1982,
    overview: "A blade runner must pursue replicants.",
    posterPath: "/poster.jpg",
    backdropPath: "/backdrop.jpg",
    externalIds: [{ source: "tmdb", externalId }],
    ...rest,
  };
}

describe("upsertTitles", () => {
  it("inserts titles and returns ids in input order", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "78", title: "Blade Runner" }),
      title({ externalId: "335984", title: "Blade Runner 2049", year: 2017 }),
    ]);

    expect(ids).toHaveLength(2);
    const rows = await getTitlesByIds(db, ids);
    expect(rows.map((r) => r.title)).toEqual(["Blade Runner", "Blade Runner 2049"]);
  });

  // Re-searching the same query must update the existing row, not duplicate
  // it. The natural key is (source, external_id), never the display title.
  it("updates an existing title rather than duplicating it", async () => {
    const [first] = await upsertTitles(db, [title({ externalId: "78", overview: "Original." })]);
    const [second] = await upsertTitles(db, [title({ externalId: "78", overview: "Updated." })]);

    expect(second).toBe(first);
    const rows = await getTitlesByIds(db, [first!]);
    expect(rows[0]?.overview).toBe("Updated.");
  });

  // Two distinct films sharing a name must stay distinct.
  it("keeps same-named titles with different external ids separate", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "1001", title: "The Thing", year: 1982 }),
      title({ externalId: "1002", title: "The Thing", year: 2011 }),
    ]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("getTitlesByIds", () => {
  // Relevance ranking lives in the id array. A plain WHERE IN returns rows in
  // whatever order PostgreSQL likes, which would silently scramble results
  // while every other assertion still passed.
  it("returns rows in the order of the requested ids", async () => {
    const ids = await upsertTitles(db, [
      title({ externalId: "2001", title: "First" }),
      title({ externalId: "2002", title: "Second" }),
      title({ externalId: "2003", title: "Third" }),
    ]);

    const reversed = [...ids].reverse();
    const rows = await getTitlesByIds(db, reversed);
    expect(rows.map((r) => r.title)).toEqual(["Third", "Second", "First"]);
  });

  it("skips ids that no longer exist", async () => {
    const ids = await upsertTitles(db, [title({ externalId: "3001" })]);
    const rows = await getTitlesByIds(db, [
      ...ids,
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @harbor/database test titles`
Expected: FAIL — cannot resolve `./titles.js`.

- [ ] **Step 3: Implement**

`packages/database/src/titles.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { titleExternalIds, titles } from "./schema.js";

export type TitleType = "movie" | "series";
export type ExternalIdSource = "tmdb" | "imdb";

export interface TitleExternalId {
  source: ExternalIdSource;
  externalId: string;
}

export interface NormalizedTitle {
  type: TitleType;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  externalIds: TitleExternalId[];
}

export interface StoredTitle extends NormalizedTitle {
  id: string;
}

/**
 * Upserts each title on its primary external id and returns the resulting
 * title ids in the same order as `items`. Callers depend on that ordering to
 * preserve provider relevance ranking.
 */
export async function upsertTitles(db: Db, items: NormalizedTitle[]): Promise<string[]> {
  const ids: string[] = [];

  for (const item of items) {
    const primary = item.externalIds[0];
    if (!primary) throw new Error("a normalized title must carry at least one external id");

    const id = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ titleId: titleExternalIds.titleId })
        .from(titleExternalIds)
        .where(eq(titleExternalIds.externalId, primary.externalId))
        .limit(1);

      const fields = {
        type: item.type,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        overview: item.overview,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        fetchedAt: new Date(),
      };

      const found = existing[0];
      if (found) {
        await tx.update(titles).set(fields).where(eq(titles.id, found.titleId));
        return found.titleId;
      }

      const inserted = await tx.insert(titles).values(fields).returning({ id: titles.id });
      const row = inserted[0];
      if (!row) throw new Error("title insert returned no row");

      await tx
        .insert(titleExternalIds)
        .values(
          item.externalIds.map((external) => ({
            titleId: row.id,
            source: external.source,
            externalId: external.externalId,
          })),
        )
        .onConflictDoNothing();

      return row.id;
    });

    ids.push(id);
  }

  return ids;
}

/**
 * Reads titles by id, preserving the order of `ids`. Ids with no surviving
 * row are omitted rather than returned as holes.
 */
export async function getTitlesByIds(db: Db, ids: string[]): Promise<StoredTitle[]> {
  if (ids.length === 0) return [];

  const rows = await db.select().from(titles).where(inArray(titles.id, ids));
  const externals = await db
    .select()
    .from(titleExternalIds)
    .where(inArray(titleExternalIds.titleId, ids));

  const externalsByTitle = new Map<string, TitleExternalId[]>();
  for (const external of externals) {
    const list = externalsByTitle.get(external.titleId) ?? [];
    list.push({ source: external.source, externalId: external.externalId });
    externalsByTitle.set(external.titleId, list);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        type: row.type,
        title: row.title,
        originalTitle: row.originalTitle,
        year: row.year,
        overview: row.overview,
        posterPath: row.posterPath,
        backdropPath: row.backdropPath,
        externalIds: externalsByTitle.get(row.id) ?? [],
      },
    ];
  });
}
```

- [ ] **Step 4: Export it**

Add `export * from "./titles.js";` to `packages/database/src/index.ts`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/database test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/titles.ts packages/database/src/titles.test.ts packages/database/src/index.ts
git commit -m "feat(database): canonical title upsert with order-preserving reads"
```

---

### Task 5: Search-result cache

**Files:**
- Create: `packages/database/src/search-cache.ts`
- Modify: `packages/database/src/index.ts`
- Test: `packages/database/src/search-cache.test.ts`

**Interfaces:**
- Produces:
  - `SEARCH_CACHE_TTL_MS: number` (3_600_000)
  - `readSearchCache(db: Db, queryHash: string, language: string, now: Date): Promise<string[] | null>`
  - `writeSearchCache(db: Db, queryHash: string, language: string, titleIds: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

`packages/database/src/search-cache.test.ts` — reuse the connection setup from `invitations.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { readSearchCache, SEARCH_CACHE_TTL_MS, writeSearchCache } from "./search-cache.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("search cache", () => {
  it("returns null on a miss", async () => {
    expect(await readSearchCache(db, "missing-hash", "en-US", new Date())).toBeNull();
  });

  it("round-trips ids and preserves their order", async () => {
    await writeSearchCache(db, "hash-order", "en-US", [B, A]);
    expect(await readSearchCache(db, "hash-order", "en-US", new Date())).toEqual([B, A]);
  });

  // Language is part of the key: the same words in two languages are two
  // different searches and must not share an entry.
  it("keys entries by language", async () => {
    await writeSearchCache(db, "hash-lang", "en-US", [A]);
    expect(await readSearchCache(db, "hash-lang", "da-DK", new Date())).toBeNull();
  });

  it("treats an entry older than the TTL as a miss", async () => {
    await writeSearchCache(db, "hash-stale", "en-US", [A]);
    const later = new Date(Date.now() + SEARCH_CACHE_TTL_MS + 1000);
    expect(await readSearchCache(db, "hash-stale", "en-US", later)).toBeNull();
  });

  it("replaces an existing entry rather than failing on the primary key", async () => {
    await writeSearchCache(db, "hash-replace", "en-US", [A]);
    await writeSearchCache(db, "hash-replace", "en-US", [B]);
    expect(await readSearchCache(db, "hash-replace", "en-US", new Date())).toEqual([B]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @harbor/database test search-cache`
Expected: FAIL — cannot resolve `./search-cache.js`.

- [ ] **Step 3: Implement**

`packages/database/src/search-cache.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { metadataSearchCache } from "./schema.js";

/** One hour. Stored here rather than in the environment so it stays tunable
 *  without replacing the container. */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

export async function readSearchCache(
  db: Db,
  queryHash: string,
  language: string,
  now: Date,
): Promise<string[] | null> {
  const rows = await db
    .select()
    .from(metadataSearchCache)
    .where(
      and(
        eq(metadataSearchCache.queryHash, queryHash),
        eq(metadataSearchCache.language, language),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - row.fetchedAt.getTime() > SEARCH_CACHE_TTL_MS) return null;
  return row.titleIds;
}

export async function writeSearchCache(
  db: Db,
  queryHash: string,
  language: string,
  titleIds: string[],
): Promise<void> {
  await db
    .insert(metadataSearchCache)
    .values({ queryHash, language, titleIds, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [metadataSearchCache.queryHash, metadataSearchCache.language],
      set: { titleIds, fetchedAt: new Date() },
    });
}
```

- [ ] **Step 4: Export it**

Add `export * from "./search-cache.js";` to `packages/database/src/index.ts`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/database test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/search-cache.ts packages/database/src/search-cache.test.ts packages/database/src/index.ts
git commit -m "feat(database): search-result cache with TTL"
```

---

### Task 6: Shared error codes and DTOs

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: error codes `METADATA_NOT_CONFIGURED`, `METADATA_PROVIDER_UNAVAILABLE`, `METADATA_PROVIDER_UNAUTHORIZED`; DTOs `MetadataConfigStatus`, `SearchResultItem`, `SearchResponse`.

- [ ] **Step 1: Extend the error codes**

In the existing `ERROR_CODES` tuple in `packages/shared/src/index.ts`, append three entries:

```ts
  "METADATA_NOT_CONFIGURED",
  "METADATA_PROVIDER_UNAVAILABLE",
  "METADATA_PROVIDER_UNAUTHORIZED",
```

- [ ] **Step 2: Add the DTOs**

Append to `packages/shared/src/index.ts`:

```ts
/**
 * What the API is willing to say about a configured provider. There is
 * deliberately no field carrying the key, masked or otherwise: a masked key
 * is still a partial credential disclosure, and the UI has no use for it.
 */
export interface MetadataConfigStatus {
  configured: boolean;
  enabled: boolean;
  language: string;
  lastVerifiedAt: string | null;
}

export interface SearchResultItem {
  id: string;
  type: "movie" | "series";
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

export interface SearchResponse {
  results: SearchResultItem[];
  /** True when served from Harbor's cache without contacting the provider.
   *  Exposed so the cache is observable in the UI and assertable in tests. */
  cached: boolean;
}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @harbor/shared test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): metadata error codes and search DTOs"
```

---

### Task 7: `MetadataProvider` contract and TMDB adapter

**Files:**
- Create: `apps/server/src/modules/metadata/providers/types.ts`, `apps/server/src/modules/metadata/providers/tmdb.ts`
- Test: `apps/server/src/modules/metadata/providers/tmdb.test.ts`

**Interfaces:**
- Consumes: `NormalizedTitle` from `@harbor/database`.
- Produces:
  - `type MetadataFailureKind = "unauthorized" | "unavailable"`
  - `class MetadataProviderError extends Error { readonly kind: MetadataFailureKind }`
  - `interface MetadataSearchQuery { query: string; language: string }`
  - `interface MetadataProvider { readonly id: string; validateConfiguration(signal: AbortSignal): Promise<void>; search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]> }`
  - `createTmdbProvider(apiKey: string, options?: { baseUrl?: string; fetchImpl?: typeof fetch }): MetadataProvider`

- [ ] **Step 1: Write the contract**

`apps/server/src/modules/metadata/providers/types.ts`:

```ts
import type { NormalizedTitle } from "@harbor/database";

export type MetadataFailureKind = "unauthorized" | "unavailable";

export class MetadataProviderError extends Error {
  constructor(
    readonly kind: MetadataFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "MetadataProviderError";
  }
}

export interface MetadataSearchQuery {
  query: string;
  language: string;
}

/**
 * CLAUDE.md sketches a six-method provider interface. Only the two methods
 * Phase 3a can honor are declared here; the detail methods (getMovie,
 * getSeries, getSeason, getEpisode) arrive in Phase 3c alongside the pages
 * that consume them. Declaring methods that throw NotImplemented would make
 * the contract a lie and invite callers to code against stubs.
 */
export interface MetadataProvider {
  readonly id: string;
  /** Resolves when the credential works; throws MetadataProviderError otherwise. */
  validateConfiguration(signal: AbortSignal): Promise<void>;
  search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]>;
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/metadata/providers/tmdb.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTmdbProvider } from "./tmdb.js";
import { MetadataProviderError } from "./types.js";

const SEARCH_PAYLOAD = {
  results: [
    {
      id: 78,
      media_type: "movie",
      title: "Blade Runner",
      original_title: "Blade Runner",
      release_date: "1982-06-25",
      overview: "A blade runner must pursue replicants.",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
    },
    {
      id: 1622,
      media_type: "tv",
      name: "Supernatural",
      original_name: "Supernatural",
      first_air_date: "2005-09-13",
      overview: "Two brothers hunt monsters.",
      poster_path: "/sn.jpg",
      backdrop_path: null,
    },
    { id: 999, media_type: "person", name: "Ridley Scott" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createTmdbProvider.search", () => {
  it("normalizes movies and series into Harbor titles", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });

    const results = await provider.search(
      { query: "blade runner", language: "en-US" },
      AbortSignal.timeout(5000),
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      type: "movie",
      title: "Blade Runner",
      originalTitle: "Blade Runner",
      year: 1982,
      overview: "A blade runner must pursue replicants.",
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      externalIds: [{ source: "tmdb", externalId: "78" }],
    });
    expect(results[1]?.type).toBe("series");
    expect(results[1]?.title).toBe("Supernatural");
    expect(results[1]?.year).toBe(2005);
  });

  // People are not titles. Passing them through would put actors in the
  // catalog as if they were watchable.
  it("drops person results", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = await provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000));
    expect(results.every((r) => r.type === "movie" || r.type === "series")).toBe(true);
  });

  it("never puts the api key in the query string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SEARCH_PAYLOAD));
    const provider = createTmdbProvider("super-secret-key", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000));

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).not.toContain("super-secret-key");
  });

  it("maps a 401 to an unauthorized failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status_message: "Invalid API key" }, 401));
    const provider = createTmdbProvider("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("maps a network failure to an unavailable failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(MetadataProviderError);
  });

  // A provider outage must not surface the upstream error text to users, and
  // must never echo the credential.
  it("keeps the api key out of thrown error messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect failed for key=super-secret-key");
    });
    const provider = createTmdbProvider("super-secret-key", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      provider.search({ query: "x", language: "en-US" }, AbortSignal.timeout(5000)),
    ).rejects.toSatisfy((error: Error) => !error.message.includes("super-secret-key"));
  });
});

describe("createTmdbProvider.validateConfiguration", () => {
  it("resolves on a successful response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    const provider = createTmdbProvider("key", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.validateConfiguration(AbortSignal.timeout(5000))).resolves.toBeUndefined();
  });

  it("throws unauthorized on a 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const provider = createTmdbProvider("bad", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(provider.validateConfiguration(AbortSignal.timeout(5000))).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @harbor/server test tmdb`
Expected: FAIL — cannot resolve `./tmdb.js`.

- [ ] **Step 4: Implement the adapter**

`apps/server/src/modules/metadata/providers/tmdb.ts`:

```ts
import type { NormalizedTitle } from "@harbor/database";
import {
  MetadataProviderError,
  type MetadataProvider,
  type MetadataSearchQuery,
} from "./types.js";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

interface TmdbSearchItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

function yearOf(value: string | undefined): number | null {
  if (!value) return null;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function normalize(item: TmdbSearchItem): NormalizedTitle | null {
  // TMDB's multi-search returns people alongside titles. People are not
  // watchable and must not enter the catalog.
  if (item.media_type !== "movie" && item.media_type !== "tv") return null;

  const isMovie = item.media_type === "movie";
  const title = isMovie ? item.title : item.name;
  if (!title) return null;

  return {
    type: isMovie ? "movie" : "series",
    title,
    originalTitle: (isMovie ? item.original_title : item.original_name) ?? null,
    year: yearOf(isMovie ? item.release_date : item.first_air_date),
    overview: item.overview ?? null,
    posterPath: item.poster_path ?? null,
    backdropPath: item.backdrop_path ?? null,
    externalIds: [{ source: "tmdb", externalId: String(item.id) }],
  };
}

export interface TmdbProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createTmdbProvider(
  apiKey: string,
  options: TmdbProviderOptions = {},
): MetadataProvider {
  const baseUrl = options.baseUrl ?? TMDB_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  // The credential travels in the Authorization header, never the query
  // string: query strings land in proxy logs, browser history, and Referer
  // headers.
  async function call(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}?${params.toString()}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal,
      });
    } catch {
      // The upstream error is deliberately swallowed rather than chained: it
      // can contain the request URL and header material.
      throw new MetadataProviderError("unavailable", "The metadata provider could not be reached.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new MetadataProviderError("unauthorized", "The metadata provider rejected the API key.");
    }
    if (!response.ok) {
      throw new MetadataProviderError(
        "unavailable",
        `The metadata provider returned status ${String(response.status)}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new MetadataProviderError("unavailable", "The metadata provider returned invalid JSON.");
    }
  }

  return {
    id: "tmdb",

    async validateConfiguration(signal: AbortSignal): Promise<void> {
      await call("/authentication", new URLSearchParams(), signal);
    },

    async search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]> {
      const params = new URLSearchParams({
        query: query.query,
        language: query.language,
        include_adult: "false",
      });
      const payload = (await call("/search/multi", params, signal)) as {
        results?: TmdbSearchItem[];
      };
      return (payload.results ?? []).flatMap((item) => {
        const normalized = normalize(item);
        return normalized ? [normalized] : [];
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/server test tmdb`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/metadata/providers
git commit -m "feat(metadata): provider contract and TMDB adapter"
```

---

### Task 8: Search orchestration

**Files:**
- Create: `apps/server/src/modules/metadata/config.ts`, `apps/server/src/modules/metadata/search.ts`
- Test: `apps/server/src/modules/metadata/search.test.ts`

**Interfaces:**
- Consumes: `getMetadataProviderConfig`, `upsertTitles`, `getTitlesByIds`, `readSearchCache`, `writeSearchCache` from `@harbor/database`; `decryptSecret` from `@harbor/crypto`; `createTmdbProvider`, `MetadataProviderError` from `./providers/`.
- Produces:
  - `class MetadataNotConfiguredError extends Error`
  - `loadProvider(db: Db, harborSecret: string): Promise<{ provider: MetadataProvider; language: string }>`
  - `hashSearchQuery(query: string): string`
  - `searchTitles(deps: SearchDeps, rawQuery: string): Promise<SearchResponse>` where `SearchDeps = { db: Db; harborSecret: string; now?: () => Date; providerFactory?: (apiKey: string) => MetadataProvider }`

- [ ] **Step 1: Declare the dependency**

`apps/server` imports `@harbor/crypto` for the first time in this task. Add it
to the `dependencies` block of `apps/server/package.json`, matching how
`@harbor/database` is declared there:

```json
"@harbor/crypto": "workspace:*",
```

Then run `pnpm install`. Skipping this produces a module-resolution failure
that looks like a missing build rather than a missing dependency.

- [ ] **Step 2: Write the provider loader**

`apps/server/src/modules/metadata/config.ts`:

```ts
import { decryptSecret } from "@harbor/crypto";
import { getMetadataProviderConfig, type Db } from "@harbor/database";
import { createTmdbProvider } from "./providers/tmdb.js";
import type { MetadataProvider } from "./providers/types.js";

export class MetadataNotConfiguredError extends Error {
  constructor() {
    super("No metadata provider is configured.");
    this.name = "MetadataNotConfiguredError";
  }
}

export interface LoadedProvider {
  provider: MetadataProvider;
  language: string;
}

export async function loadProvider(
  db: Db,
  harborSecret: string,
  providerFactory: (apiKey: string) => MetadataProvider = (key) => createTmdbProvider(key),
): Promise<LoadedProvider> {
  const config = await getMetadataProviderConfig(db, "tmdb");
  if (!config || !config.enabled || !config.encryptedApiKey) {
    throw new MetadataNotConfiguredError();
  }

  // A decryption failure propagates as SecretDecryptionError rather than
  // being flattened into "not configured". An operator who rotated
  // HARBOR_SECRET needs to be told that, not sent to re-run onboarding.
  const apiKey = decryptSecret(config.encryptedApiKey, harborSecret);
  return { provider: providerFactory(apiKey), language: config.language };
}
```

- [ ] **Step 3: Write the failing test**

`apps/server/src/modules/metadata/search.test.ts` — reuse the database connection setup from `packages/database/src/invitations.test.ts`, adapted to this package's test conventions.

```ts
import { saveMetadataProviderConfig } from "@harbor/database";
import { encryptSecret } from "@harbor/crypto";
import { describe, expect, it, vi } from "vitest";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";
import { searchTitles } from "./search.js";

const HARBOR_SECRET = "0123456789abcdef0123456789abcdef";

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

async function configure(db: never): Promise<void> {
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
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm --filter @harbor/server test search`
Expected: FAIL — cannot resolve `./search.js`.

- [ ] **Step 5: Implement**

`apps/server/src/modules/metadata/search.ts`:

```ts
import { createHash } from "node:crypto";
import {
  getTitlesByIds,
  readSearchCache,
  upsertTitles,
  writeSearchCache,
  type Db,
  type StoredTitle,
} from "@harbor/database";
import type { SearchResponse, SearchResultItem } from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

const PROVIDER_TIMEOUT_MS = 10_000;

export interface SearchDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
}

/** Normalizes case and surrounding whitespace so trivially different
 *  spellings of the same search share one cache entry. */
export function hashSearchQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase(), "utf8").digest("hex");
}

function toResultItem(title: StoredTitle): SearchResultItem {
  return {
    id: title.id,
    type: title.type,
    title: title.title,
    year: title.year,
    overview: title.overview,
    posterPath: title.posterPath,
  };
}

export async function searchTitles(deps: SearchDeps, rawQuery: string): Promise<SearchResponse> {
  const now = deps.now ?? (() => new Date());
  const { provider, language } = await loadProvider(deps.db, deps.harborSecret, deps.providerFactory);
  const queryHash = hashSearchQuery(rawQuery);

  const cachedIds = await readSearchCache(deps.db, queryHash, language, now());
  if (cachedIds) {
    return { results: (await getTitlesByIds(deps.db, cachedIds)).map(toResultItem), cached: true };
  }

  let normalized;
  try {
    normalized = await provider.search(
      { query: rawQuery.trim(), language },
      AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    );
  } catch (error) {
    // A provider outage should degrade to stale results rather than an error
    // page. Expiry is a freshness preference; an outage is not a reason to
    // withhold data Harbor already has.
    if (error instanceof MetadataProviderError && error.kind === "unavailable") {
      const stale = await readSearchCache(deps.db, queryHash, language, new Date(0));
      if (stale) {
        return { results: (await getTitlesByIds(deps.db, stale)).map(toResultItem), cached: true };
      }
    }
    throw error;
  }

  const ids = await upsertTitles(deps.db, normalized);
  await writeSearchCache(deps.db, queryHash, language, ids);

  return { results: (await getTitlesByIds(deps.db, ids)).map(toResultItem), cached: false };
}
```

Note the fallback read passes `new Date(0)`, which makes every entry appear fresh and so returns whatever is stored regardless of age.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/server test search`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/metadata/config.ts apps/server/src/modules/metadata/search.ts apps/server/src/modules/metadata/search.test.ts
git commit -m "feat(metadata): remote-first search with cache-on-read"
```

---

### Task 9: HTTP routes

**Files:**
- Create: `apps/server/src/modules/metadata/routes.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/modules/metadata/routes.test.ts`

**Interfaces:**
- Consumes: `requireRole` from `../../plugins/require-role.js`; `HarborError` from `../../plugins/errors.js`; `searchTitles`, `loadProvider`, `MetadataNotConfiguredError`.
- Produces: `metadataRoutes: FastifyPluginAsync`.

- [ ] **Step 1: Write the routes**

`apps/server/src/modules/metadata/routes.ts`:

```ts
import { encryptSecret } from "@harbor/crypto";
import { getMetadataProviderConfig, saveMetadataProviderConfig } from "@harbor/database";
import type { MetadataConfigStatus, SearchResponse } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { requireRole } from "../../plugins/require-role.js";
import { MetadataNotConfiguredError } from "./config.js";
import { createTmdbProvider } from "./providers/tmdb.js";
import { MetadataProviderError } from "./providers/types.js";
import { searchTitles } from "./search.js";

const VALIDATE_TIMEOUT_MS = 10_000;

const ConfigSchema = z.object({
  apiKey: z.string().min(1).max(512),
  language: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/, "Language must look like en-US.")
    .default("en-US"),
  enabled: z.boolean().default(true),
});

const SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) });

function toStatus(
  row: { enabled: boolean; encryptedApiKey: string | null; language: string; lastVerifiedAt: Date | null } | null,
): MetadataConfigStatus {
  return {
    configured: row?.encryptedApiKey != null,
    enabled: row?.enabled ?? false,
    language: row?.language ?? "en-US",
    lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
  };
}

/** Translates domain failures into the API error contract. Provider error
 *  text is never forwarded: it can name upstream hosts and request details. */
function toHarborError(error: unknown): HarborError {
  if (error instanceof MetadataNotConfiguredError) {
    return new HarborError(
      "METADATA_NOT_CONFIGURED",
      "No metadata provider is configured. An administrator can set one up in Settings.",
      409,
    );
  }
  if (error instanceof MetadataProviderError) {
    return error.kind === "unauthorized"
      ? new HarborError(
          "METADATA_PROVIDER_UNAUTHORIZED",
          "The metadata provider rejected Harbor's API key. An administrator must update it.",
          502,
        )
      : new HarborError(
          "METADATA_PROVIDER_UNAVAILABLE",
          "The metadata provider is currently unreachable. Try again shortly.",
          503,
        );
  }
  throw error;
}

export const metadataRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/admin/metadata/config",
    { preHandler: [requireRole("administrator")] },
    async (): Promise<MetadataConfigStatus> => {
      return toStatus(await getMetadataProviderConfig(fastify.db, "tmdb"));
    },
  );

  fastify.post(
    "/admin/metadata/test",
    {
      preHandler: [requireRole("administrator")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request): Promise<{ valid: true }> => {
      const parsed = ConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      try {
        await createTmdbProvider(parsed.data.apiKey).validateConfiguration(
          AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        );
      } catch (error) {
        throw toHarborError(error);
      }
      return { valid: true };
    },
  );

  fastify.put(
    "/admin/metadata/config",
    {
      preHandler: [requireRole("administrator")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request): Promise<MetadataConfigStatus> => {
      const parsed = ConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      const { apiKey, language, enabled } = parsed.data;

      // Validate before persisting, so an administrator cannot save a key
      // that does not work and then wonder why search is broken.
      try {
        await createTmdbProvider(apiKey).validateConfiguration(
          AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        );
      } catch (error) {
        throw toHarborError(error);
      }

      await saveMetadataProviderConfig(fastify.db, {
        providerId: "tmdb",
        enabled,
        encryptedApiKey: encryptSecret(apiKey, fastify.env.HARBOR_SECRET),
        language,
        lastVerifiedAt: new Date(),
      });

      fastify.log.info({ providerId: "tmdb" }, "metadata provider configured");
      return toStatus(await getMetadataProviderConfig(fastify.db, "tmdb"));
    },
  );

  fastify.get(
    "/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request): Promise<SearchResponse> => {
      const parsed = SearchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      try {
        return await searchTitles(
          { db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET },
          parsed.data.q,
        );
      } catch (error) {
        throw toHarborError(error);
      }
    },
  );
};
```

- [ ] **Step 2: Register the routes**

In `apps/server/src/app.ts`, add the import alongside the other module imports:

```ts
import { metadataRoutes } from "./modules/metadata/routes.js";
```

and register it next to the existing `invitationsRoutes` registration, using the identical prefix pattern already used there.

- [ ] **Step 3: Write the route tests**

`apps/server/src/modules/metadata/routes.test.ts` — follow the authenticated-request setup in `apps/server/src/modules/invitations/routes.test.ts`.

```ts
import { describe, expect, it } from "vitest";

describe("metadata routes authorization", () => {
  it("rejects an anonymous request for the config", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/metadata/config" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a plain user reading the config", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/metadata/config",
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a plain user writing the config", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/metadata/config",
      cookies: { [SESSION_COOKIE]: userToken },
      payload: { apiKey: "x", language: "en-US", enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an anonymous search", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=blade" });
    expect(res.statusCode).toBe(401);
  });

  it("reports an unconfigured provider distinctly, not as a server error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=blade",
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("METADATA_NOT_CONFIGURED");
  });

  it("rejects an empty search query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=",
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @harbor/server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/metadata/routes.ts apps/server/src/modules/metadata/routes.test.ts apps/server/src/app.ts
git commit -m "feat(metadata): admin configuration and search routes"
```

---

### Task 10: Prove the key never escapes

**Files:**
- Test: `apps/server/src/modules/metadata/key-secrecy.test.ts`

This task exists because Phase 2b shipped a credential-redaction fix whose unit test passed while the real leak continued. Asserting the property at the boundary is the only evidence that counts.

**Interfaces:**
- Consumes: `createApp` and the test helpers used in `apps/server/src/request-log-redaction.test.ts`.

- [ ] **Step 1: Write the test**

`apps/server/src/modules/metadata/key-secrecy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

const SECRET_KEY = "tmdb-secret-key-do-not-leak-9x7q";

describe("provider key secrecy", () => {
  // Configure a key through the real route, then read the config back and
  // assert the response cannot be used to recover it -- not in full, and not
  // as a masked fragment.
  it("never returns the api key from the config endpoint", async () => {
    await putConfig(SECRET_KEY);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/metadata/config",
      cookies: { [SESSION_COOKIE]: adminToken },
    });

    const raw = res.body;
    expect(raw).not.toContain(SECRET_KEY);
    expect(raw).not.toContain(SECRET_KEY.slice(-4));
    expect(res.json().configured).toBe(true);
  });

  it("never writes the api key to the log", async () => {
    // `lines` is the capture array wired into the app's logger, following
    // the pattern in apps/server/src/request-log-redaction.test.ts.
    await putConfig(SECRET_KEY);
    expect(lines.join("\n")).not.toContain(SECRET_KEY);
  });

  it("stores the key encrypted rather than in plaintext", async () => {
    await putConfig(SECRET_KEY);
    const row = await getMetadataProviderConfig(db, "tmdb");
    expect(row?.encryptedApiKey).not.toContain(SECRET_KEY);
    expect(row?.encryptedApiKey?.startsWith("v1:")).toBe(true);
  });
});
```

The `putConfig` helper posts to `PUT /api/v1/admin/metadata/config` with an administrator cookie and a stubbed provider that validates successfully, so the test does not require network access.

- [ ] **Step 2: Prove the tests are load-bearing**

Temporarily add `apiKeyEcho: row?.encryptedApiKey ?? null` to the object returned by `toStatus` in `routes.ts` and re-run.

Run: `pnpm --filter @harbor/server test key-secrecy`
Expected: the encryption assertion still passes but the response assertions now have a real field to catch. Then temporarily change `toStatus` to return the **plaintext** key and confirm the first test **fails**. Revert both edits.

A secrecy test that passes when the secret is deliberately leaked is worthless. This step is what distinguishes the two.

- [ ] **Step 3: Run the full suite**

Run: `pnpm --filter @harbor/server test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/metadata/key-secrecy.test.ts
git commit -m "test(metadata): prove the provider key never leaves the server"
```

---

### Task 11: Admin metadata page

**Files:**
- Create: `apps/web/src/pages/AdminMetadata.tsx`
- Modify: `apps/web/src/routes.tsx`

Remember: `apps/web` uses **extensionless** imports.

**Interfaces:**
- Consumes: `MetadataConfigStatus` from `@harbor/shared`.
- Produces: route `/admin/metadata`.

- [ ] **Step 1: Build the page**

`apps/web/src/pages/AdminMetadata.tsx`. Follow the structure, form handling, and styling of `apps/web/src/pages/Invitations.tsx`, which is the closest existing admin page. Requirements:

- Load status from `GET /api/v1/admin/metadata/config` with TanStack Query.
- Show one of three states: **not configured** (prompt to add a key), **configured** (show `language` and `lastVerifiedAt`), or **load error**.
- A form with an API key field (`type="password"`, `autoComplete="off"`), a language field defaulting to `en-US`, a **Test connection** button calling `POST /admin/metadata/test`, and a **Save** button calling `PUT /admin/metadata/config`.
- After a successful save, clear the API key field from component state. The key must not linger in the DOM or in React state after it has been submitted.
- Surface `METADATA_PROVIDER_UNAUTHORIZED` as "TMDB rejected this key" and `METADATA_PROVIDER_UNAVAILABLE` as "TMDB could not be reached — this is not a problem with your key."
- Render the TMDB attribution required by their API terms: *"This product uses the TMDB API but is not endorsed or certified by TMDB."*
- Every input needs an associated `<label>`; the page must be keyboard navigable with visible focus states.

- [ ] **Step 2: Add the route**

In `apps/web/src/routes.tsx`, add `/admin/metadata` alongside the existing `/admin/invitations` route, using the same admin guard.

- [ ] **Step 3: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @harbor/web build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/AdminMetadata.tsx apps/web/src/routes.tsx
git commit -m "feat(web): admin metadata provider configuration page"
```

---

### Task 12: Search scaffolding and the manual checkpoint

**Files:**
- Create: `apps/web/src/pages/Search.tsx`
- Modify: `apps/web/src/routes.tsx`
- Create: `docs/metadata.md`

**This page is deliberately plain.** It proves the pipeline and will be replaced in Phase 3c. Do not design catalog layout here — poster grids, rows, and hover states are 3c decisions that have not been made yet.

- [ ] **Step 1: Build the page**

`apps/web/src/pages/Search.tsx`:

- A labeled text input and a submit button. Submit on Enter.
- Debounce or submit-only — do not fire a request per keystroke; the endpoint is rate limited at 60/minute.
- Render results as a plain list: title, year, type. No posters — image handling is Phase 3b.
- Display the `cached` flag visibly, for example "served from cache" versus "fetched from TMDB". This is what makes the cache observable during manual testing.
- Handle the three error codes with distinct messages, and link to `/admin/metadata` on `METADATA_NOT_CONFIGURED`.
- Include the TMDB attribution string.

- [ ] **Step 2: Add the route**

Add `/search` to `apps/web/src/routes.tsx` behind the authenticated guard.

- [ ] **Step 3: Write the documentation**

`docs/metadata.md` covering: how to obtain a TMDB API key, that the key is encrypted with a key derived from `HARBOR_SECRET`, **that rotating `HARBOR_SECRET` invalidates the stored key and requires re-entering it**, the one-hour search cache TTL, and the behavior when TMDB is unreachable.

- [ ] **Step 4: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Search.tsx apps/web/src/routes.tsx docs/metadata.md
git commit -m "feat(web): search scaffolding proving the metadata pipeline"
```

- [ ] **Step 6: Stop for manual testing**

Start a local instance and hand it to the user. They will:

1. Sign in as owner and open `/admin/metadata`.
2. Save a real TMDB key and see it validate.
3. Open `/search`, search "Blade Runner", and see results marked **fetched from TMDB**.
4. Search the same term again and see results marked **served from cache**.

Do not proceed to a final review until the user confirms this works. Every phase so far has had defects at this checkpoint that no automated test caught.

---

### Task 13: End-to-end journey and outage resilience

**Files:**
- Create: `e2e/tests/metadata.spec.ts`
- Test: `apps/server/src/modules/metadata/readiness.test.ts`

Run this only after the user has confirmed the manual checkpoint.

**Interfaces:**
- Consumes: the existing Playwright fixtures in `e2e/`, following
  `e2e/tests/invitations.spec.ts` for setup, owner sign-in, and database
  isolation.

- [ ] **Step 1: Write the readiness test**

`apps/server/src/modules/metadata/readiness.test.ts`. `CLAUDE.md` states
readiness must not fail because a metadata provider is down, and nothing
currently proves it:

```ts
import { describe, expect, it } from "vitest";

describe("readiness under provider outage", () => {
  it("stays ready when the metadata provider is unreachable", async () => {
    // Configure a provider whose validate/search always throw
    // MetadataProviderError("unavailable", ...), then confirm readiness is
    // unaffected. A metadata outage is a third-party problem; reporting the
    // container unhealthy would make an orchestrator restart Harbor for no
    // reason and take working functionality offline with it.
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
  });
});
```

- [ ] **Step 2: Write the end-to-end journey**

`e2e/tests/metadata.spec.ts`. The provider must be stubbed — **e2e must not
call TMDB.** Route-intercept the outbound call or point the adapter at a local
fixture server, following whichever isolation approach `e2e/` already uses.

Cover the full journey in one test:

1. Complete setup and sign in as owner.
2. Open `/admin/metadata`, submit a key, and see it saved.
3. Open `/search`, search a term, and assert results appear marked as fetched
   from the provider.
4. Search the same term again and assert results are marked as served from
   cache.
5. Assert the page source contains the TMDB attribution string.

Then a second test for authorization: a signed-in plain user opening
`/admin/metadata` must not be able to read or write the configuration.

- [ ] **Step 3: Run both**

Run: `pnpm --filter @harbor/server test readiness && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 4: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/metadata.spec.ts apps/server/src/modules/metadata/readiness.test.ts
git commit -m "test: metadata journey and readiness under provider outage"
```

---

## Definition of Done

- [ ] `@harbor/crypto` encrypts and decrypts provider secrets, detects tampering, and fails loudly under a rotated `HARBOR_SECRET`
- [ ] Schema and migration create the four new tables with no destructive change
- [ ] Titles upsert on `(source, external_id)` and read back in requested order
- [ ] Search cache is keyed by query hash and language and honors the one-hour TTL
- [ ] The TMDB adapter normalizes movies and series, drops people, and sends the key in a header rather than a query string
- [ ] Search queries the provider on a cold cache and PostgreSQL on a warm one, proven by asserting the absence of an outbound call
- [ ] A provider outage degrades to stale cached results rather than an error
- [ ] All four routes enforce their roles; search requires authentication
- [ ] "Not configured" is a distinct 409, never a 500
- [ ] The API key never appears in a response, a log line, or the database in plaintext — proven by a test that fails when the key is deliberately leaked
- [ ] Readiness still passes while TMDB is unreachable
- [ ] TMDB attribution appears in the interface
- [ ] `docs/metadata.md` documents the `HARBOR_SECRET` rotation consequence
- [ ] No commit carries an AI attribution trailer
