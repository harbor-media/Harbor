# Harbor Phase 2a — Identity Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a freshly deployed Harbor from "not set up" to "the owner is logged in," with every route that is not explicitly public refusing unauthenticated requests.

**Architecture:** Two new tables (`users`, `sessions`) in the existing Drizzle schema. Argon2id password hashing. Opaque session tokens stored only as SHA-256 hashes. A single global `onRequest` hook authenticates every request against an exact-match public allowlist, so a route added without thought is protected by default. Owner creation and setup completion happen in one transaction, update-first, so a failure leaves the install retryable rather than bricked.

**Tech Stack:** Node.js (root `engines` requires `>=22.22.0`; CI and the Docker image build on Node 24), TypeScript 6.0.3, Fastify 5.10, `@node-rs/argon2` 2.0.2, `@fastify/cookie` 11.1.2, Drizzle 0.45.2 + postgres.js, Zod 4.4.3, React 19, Vitest 4.1.10, Testcontainers 12.0.4, Playwright 1.61.1.

## Global Constraints

- **TypeScript is exactly `6.0.3`.** `typescript-eslint@8.64.0` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript 7 is npm `latest` but breaks linting.
- **Exact dependency versions, no `^` or `~`.**
- **Import extensions differ by package and this is intentional:**
  - `packages/*` and `apps/server` use `moduleResolution: nodenext` — relative imports **must** carry `.js` even for `.ts` sources. Writing `./foo.ts` gives `TS5097`.
  - `apps/web` uses `moduleResolution: bundler` — relative imports are **extensionless**.
- `"type": "module"` everywhere. LF line endings (enforced by `.gitattributes`).
- **Never add a `Co-Authored-By:` trailer or any AI-attribution footer to a commit message.** Subject and body only.
- Root ESLint errors on `no-console` and requires `consistent-type-imports`. Underscore-prefixed and rest-sibling variables are exempt.
- API base path is `/api/v1`. Internal port 3000.
- **Never log passwords, raw session tokens, or password hashes.** `packages/logger` redacts known key names; do not defeat it by interpolating secrets into message strings.

### Version-specific traps (verified 2026-07-20)

1. **`@node-rs/argon2@2.0.2` defaults are `memoryCost: 4096, timeCost: 3`** — NOT the `19456/2` shown in the package's GitHub README, which documents a later release. **Always pass parameters explicitly.** Relying on defaults silently weakens hashing below OWASP guidance.
2. **`verify()` resolves `false` on a wrong password but REJECTS on a malformed hash.** Wrap in try/catch AND check the boolean. Treating "no exception" as success is an authentication bypass.
3. **Fastify routes before `onRequest` fires**, so `request.routeOptions.url` holds the matched route pattern inside that hook. This is what makes allowlist matching possible there.
4. **An async Fastify hook that sends a reply must `return reply`**, or Fastify continues the chain and throws `FST_ERR_REP_ALREADY_SENT`.
5. **`clearCookie` must pass the same `path`** used when setting, or the browser keeps the original cookie.
6. **`gen_random_uuid()` is built into PostgreSQL 13+** — no `pgcrypto` extension needed on PG17.
7. **Drizzle's `or`, `eq`, `and`, `isNull` import from the root `drizzle-orm`**, not `drizzle-orm/pg-core`.
8. **`@playwright/test` does not bundle browsers** — CI needs `pnpm exec playwright install --with-deps chromium`.
9. **`@node-rs/argon2@2.0.2` declares `Algorithm` as an ambient `const enum`.** `tsconfig.base.json` sets `isolatedModules: true`, which forbids importing ambient const enums (`TS2748`). Import only `hash` and `verify`, and inline the numeric value.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/database/src/schema.ts` | Add `userRole` enum, `users`, `sessions` tables |
| `packages/database/src/users.ts` | User queries: create, lookup by identifier, failed-login counters |
| `packages/database/src/sessions.ts` | Session queries: create, lookup by hash, delete, delete-all-for-user |
| `packages/database/src/setup.ts` | The owner-creation transaction |
| `packages/shared/src/index.ts` | `UNAUTHENTICATED` code, auth request/response contracts |
| `apps/server/src/modules/auth/passwords.ts` | Argon2id hash/verify, dummy-hash timing defense |
| `apps/server/src/modules/auth/tokens.ts` | Session token generation and hashing |
| `apps/server/src/modules/auth/throttle.ts` | Backoff computation, bounded in-memory attempt store (per-IP and per-unknown-identifier) |
| `apps/server/src/modules/auth/cookies.ts` | Cookie set/clear with derived `Secure` |
| `apps/server/src/modules/auth/routes.ts` | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| `apps/server/src/modules/setup/routes.ts` | `POST /setup` |
| `apps/server/src/plugins/auth.ts` | Global `onRequest` guard + public allowlist |
| `apps/server/src/plugins/origin.ts` | Origin/Referer check on mutating requests |
| `apps/web/src/pages/Setup.tsx` | Owner setup wizard |
| `apps/web/src/pages/Login.tsx` | Login form |
| `apps/web/src/auth.ts` | Client auth queries and mutations |
| `e2e/` | Playwright package: config + setup and login flows |

---

## Task 1: Schema — users and sessions tables

**Files:**
- Modify: `packages/database/src/schema.ts`
- Generate: `packages/database/drizzle/0001_*.sql`

**Interfaces:**
- Consumes: existing `installation` table
- Produces: `userRole` pgEnum; `users` and `sessions` tables; types `User`, `NewUser`, `Session`; `installation.serverName`, `installation.language`

- [ ] **Step 1: Replace `packages/database/src/schema.ts`**

Note `inet` and `pgEnum` are native to `drizzle-orm/pg-core`. `uuid().defaultRandom()` emits `gen_random_uuid()`, which PostgreSQL 17 provides natively with no extension.

```ts
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "administrator", "user", "guest"]);

export const installation = pgTable(
  "installation",
  {
    id: boolean("id").primaryKey().default(true),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true, mode: "date" }),
    serverName: text("server_name"),
    language: text("language"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("installation_singleton", sql`${t.id} = true`)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  userAgent: text("user_agent"),
  ip: inet("ip"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type Installation = typeof installation.$inferSelect;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @harbor/database db:generate`
Expected: creates `packages/database/drizzle/0001_<name>.sql`.

- [ ] **Step 3: Inspect the generated SQL**

Open the new file and confirm it contains all of:
- `CREATE TYPE "public"."user_role" AS ENUM('owner', 'administrator', 'user', 'guest')`
- `CREATE TABLE "users"` with `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL`
- `CREATE TABLE "sessions"` with `"ip" inet` and a foreign key carrying `ON DELETE cascade`
- `ALTER TABLE "installation" ADD COLUMN "server_name" text` and `"language" text`

Paste the full SQL into your report. If the cascade or the enum is missing, the schema is wrong — fix `schema.ts` and regenerate rather than hand-editing SQL.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @harbor/database build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/database
git commit -m "feat(database): users and sessions schema"
```

---

## Task 2: User and session queries

**Files:**
- Create: `packages/database/src/users.ts`, `packages/database/src/sessions.ts`, `packages/database/src/identity.test.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `Db`, `users`, `sessions`, `User`, `Session` from Task 1
- Produces:
  - `createUser(db, input: NewUserInput): Promise<User>` where `NewUserInput = { username, email, passwordHash, role }`
  - `findUserByIdentifier(db, identifier: string): Promise<User | null>`
  - `findUserById(db, id: string): Promise<User | null>`
  - `recordFailedLogin(db, userId: string): Promise<number>` — returns the new count
  - `resetFailedLogins(db, userId: string): Promise<void>`
  - `createSession(db, input: NewSessionInput): Promise<Session>` where `NewSessionInput = { userId, tokenHash, expiresAt, userAgent, ip }`
  - `findSessionByTokenHash(db, tokenHash: string): Promise<{ session: Session; user: User } | null>`
  - `touchSession(db, id: string): Promise<void>`
  - `deleteSession(db, id: string): Promise<void>`
  - `deleteSessionsForUser(db, userId: string): Promise<number>` — returns rows deleted

- [ ] **Step 1: Write the failing test**

`packages/database/src/identity.test.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  createUser,
  findUserById,
  findUserByIdentifier,
  recordFailedLogin,
  resetFailedLogins,
} from "./users.js";
import {
  createSession,
  deleteSession,
  deleteSessionsForUser,
  findSessionByTokenHash,
} from "./sessions.js";
import { sql } from "drizzle-orm";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

let container: StartedPostgreSqlContainer;
let url: string;
let client: Awaited<ReturnType<typeof createClient>>["sql"];
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  url = container.getConnectionUri();
  await runMigrations(url, migrationsFolder);
  const c = createClient(url, { max: 5 });
  client = c.sql;
  db = c.db;
}, 120_000);

afterAll(async () => {
  await closeClient(client);
  await container.stop();
});

beforeEach(async () => {
  await db.execute(sql`truncate table sessions, users restart identity cascade`);
});

const base = { username: "owner", email: "owner@example.com", passwordHash: "hash", role: "owner" as const };

describe("users", () => {
  it("creates a user and finds it by username or email", async () => {
    const created = await createUser(db, base);
    expect(created.id).toBeTruthy();
    expect(created.role).toBe("owner");

    expect((await findUserByIdentifier(db, "owner"))?.id).toBe(created.id);
    expect((await findUserByIdentifier(db, "owner@example.com"))?.id).toBe(created.id);
    expect(await findUserByIdentifier(db, "nobody")).toBeNull();
    expect((await findUserById(db, created.id))?.username).toBe("owner");
  });

  it("rejects a duplicate username", async () => {
    await createUser(db, base);
    await expect(createUser(db, { ...base, email: "other@example.com" })).rejects.toThrow();
  });

  it("allows a null email and rejects duplicate emails", async () => {
    await createUser(db, { ...base, email: null });
    await createUser(db, { ...base, username: "second", email: null });
    await createUser(db, { ...base, username: "third", email: "x@example.com" });
    await expect(
      createUser(db, { ...base, username: "fourth", email: "x@example.com" }),
    ).rejects.toThrow();
  });

  it("tracks and resets failed logins", async () => {
    const u = await createUser(db, base);
    expect(await recordFailedLogin(db, u.id)).toBe(1);
    expect(await recordFailedLogin(db, u.id)).toBe(2);

    const after = await findUserById(db, u.id);
    expect(after?.lastFailedLoginAt).toBeInstanceOf(Date);

    await resetFailedLogins(db, u.id);
    const reset = await findUserById(db, u.id);
    expect(reset?.failedLoginCount).toBe(0);
    expect(reset?.lastFailedLoginAt).toBeNull();
  });
});

describe("sessions", () => {
  it("creates a session and finds it with its user", async () => {
    const u = await createUser(db, base);
    const expiresAt = new Date(Date.now() + 60_000);
    const s = await createSession(db, {
      userId: u.id,
      tokenHash: "hash-a",
      expiresAt,
      userAgent: "test-agent",
      ip: "203.0.113.5",
    });

    const found = await findSessionByTokenHash(db, "hash-a");
    expect(found?.session.id).toBe(s.id);
    expect(found?.user.username).toBe("owner");
    expect(await findSessionByTokenHash(db, "nope")).toBeNull();
  });

  it("deletes a single session", async () => {
    const u = await createUser(db, base);
    const s = await createSession(db, {
      userId: u.id,
      tokenHash: "hash-b",
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ip: null,
    });
    await deleteSession(db, s.id);
    expect(await findSessionByTokenHash(db, "hash-b")).toBeNull();
  });

  it("deletes every session for a user", async () => {
    const u = await createUser(db, base);
    for (const h of ["h1", "h2", "h3"]) {
      await createSession(db, {
        userId: u.id,
        tokenHash: h,
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ip: null,
      });
    }
    expect(await deleteSessionsForUser(db, u.id)).toBe(3);
    expect(await findSessionByTokenHash(db, "h1")).toBeNull();
  });

  it("cascades session deletion when the user is deleted", async () => {
    const u = await createUser(db, base);
    await createSession(db, {
      userId: u.id,
      tokenHash: "cascade",
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ip: null,
    });
    await db.execute(sql`delete from users where id = ${u.id}`);
    expect(await findSessionByTokenHash(db, "cascade")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/database test`
Expected: FAIL — cannot resolve `./users.js` and `./sessions.js`. Docker must be running.

- [ ] **Step 3: Create `packages/database/src/users.ts`**

Usernames and emails are normalized to lowercase on write and on lookup. Storing them normalized means the unique constraint enforces case-insensitivity without a functional index or the `citext` extension.

```ts
import { eq, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { users, type User } from "./schema.js";

export interface NewUserInput {
  username: string;
  email: string | null;
  passwordHash: string;
  role: "owner" | "administrator" | "user" | "guest";
}

/** Lowercased so the unique constraint enforces case-insensitive identity. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function createUser(db: Db, input: NewUserInput): Promise<User> {
  const rows = await db
    .insert(users)
    .values({
      username: normalize(input.username),
      email: input.email === null ? null : normalize(input.email),
      passwordHash: input.passwordHash,
      role: input.role,
    })
    .returning();

  const created = rows[0];
  if (!created) throw new Error("user insert returned no row");
  return created;
}

export async function findUserByIdentifier(db: Db, identifier: string): Promise<User | null> {
  const value = normalize(identifier);
  const rows = await db
    .select()
    .from(users)
    .where(or(eq(users.username, value), eq(users.email, value)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Increments the counter atomically and returns the new value. */
export async function recordFailedLogin(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(users)
    .set({
      failedLoginCount: sql`${users.failedLoginCount} + 1`,
      lastFailedLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ count: users.failedLoginCount });
  return rows[0]?.count ?? 0;
}

export async function resetFailedLogins(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lastFailedLoginAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
```

- [ ] **Step 4: Create `packages/database/src/sessions.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { sessions, users, type Session, type User } from "./schema.js";

export interface NewSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export async function createSession(db: Db, input: NewSessionInput): Promise<Session> {
  const rows = await db.insert(sessions).values(input).returning();
  const created = rows[0];
  if (!created) throw new Error("session insert returned no row");
  return created;
}

export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<{ session: Session; user: User } | null> {
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(db: Db, id: string): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id));
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function deleteSessionsForUser(db: Db, userId: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({
    id: sessions.id,
  });
  return rows.length;
}
```

- [ ] **Step 5: Update `packages/database/src/index.ts`**

```ts
export * from "./client.js";
export * from "./installation.js";
export * from "./migrate.js";
export * from "./schema.js";
export * from "./sessions.js";
export * from "./users.js";
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @harbor/database test`
Expected: PASS — the pre-existing migration tests plus 7 new ones.

- [ ] **Step 7: Commit**

```bash
git add packages/database
git commit -m "feat(database): user and session queries"
```

---

## Task 3: Shared auth contracts

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `UNAUTHENTICATED` error code; `AuthenticatedUser`, `LoginRequest`, `SetupRequest` types

- [ ] **Step 1: Add to `packages/shared/src/index.ts`**

Add `"UNAUTHENTICATED"` to the `ERROR_CODES` tuple (keep every existing entry), then append:

```ts
export type UserRole = "owner" | "administrator" | "user" | "guest";

/** Exactly what GET /api/v1/auth/me returns. Never includes hashes or tokens. */
export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
}

export interface LoginRequest {
  /** Username or email — the client does not need to know which. */
  identifier: string;
  password: string;
}

export interface SetupRequest {
  language: string;
  serverName: string;
  username: string;
  email: string;
  password: string;
}
```

- [ ] **Step 2: Verify the emitted union**

Run: `pnpm --filter @harbor/shared build`
Then confirm `packages/shared/dist/index.d.ts` declares `ERROR_CODES` as a `readonly [...]` tuple of string literals including `"UNAUTHENTICATED"`. Paste that line into your report — it proves `as const` survived and `ErrorCode` is still a literal union rather than `string`.

- [ ] **Step 3: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): auth contracts and UNAUTHENTICATED code"
```

---

## Task 4: Password hashing

**Files:**
- Create: `apps/server/src/modules/auth/passwords.ts`, `apps/server/src/modules/auth/passwords.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Produces:
  - `hashPassword(password: string): Promise<string>`
  - `verifyPassword(hash: string, password: string): Promise<boolean>`
  - `verifyAgainstDummy(): Promise<void>` — constant-work path for unknown users

- [ ] **Step 1: Add the dependency**

Add to `apps/server/package.json` `dependencies`, exact version:

```json
    "@node-rs/argon2": "2.0.2",
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/auth/passwords.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";

describe("password hashing", () => {
  it("produces a PHC string with the configured Argon2id parameters", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // Guards the trap: @node-rs/argon2@2.0.2 defaults to m=4096,t=3.
    // If parameters were not passed explicitly, this assertion fails.
    // The `$argon2id$` prefix additionally proves the inlined ARGON2ID = 2
    // constant is the right numeric value for Argon2id.
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
    expect(hash).toContain("p=1");
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).not.toContain("hunter2");
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("accepts the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(await verifyPassword(hash, "s3cret-password")).toBe(true);
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    // argon2 REJECTS on a malformed PHC string. If this propagated, a corrupt
    // row would surface as a 500 instead of a failed login.
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
  });

  it("verifyAgainstDummy resolves without throwing", async () => {
    await expect(verifyAgainstDummy()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @harbor/server test passwords`
Expected: FAIL — cannot resolve `./passwords.js`.

- [ ] **Step 4: Create `apps/server/src/modules/auth/passwords.ts`**

```ts
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** Algorithm.Argon2id === 2. Inlined because @node-rs/argon2 declares Algorithm
 *  as an ambient `const enum`, which `isolatedModules: true` forbids importing. */
const ARGON2ID = 2;

/**
 * OWASP's balanced Argon2id profile, sized for the home servers and small VPSes
 * Harbor targets.
 *
 * These MUST be passed explicitly. @node-rs/argon2@2.0.2 defaults to
 * memoryCost 4096 / timeCost 3 — its GitHub README documents a later release's
 * stronger defaults, so relying on them silently weakens hashing.
 */
const HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/**
 * Verification parameters come from the stored PHC string, so options are not
 * passed here. Returns false for a wrong password AND for a malformed hash —
 * argon2 rejects on the latter, and an unreadable hash is an authentication
 * failure, not a server error.
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/**
 * Computed once on first use and cached, so login spends comparable time
 * whether or not the account exists. Without this, a fast "no such user"
 * response leaks which usernames are registered.
 */
let dummyHash: Promise<string> | null = null;

export async function verifyAgainstDummy(): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(await dummyHash, "wrong");
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/server test passwords`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): Argon2id password hashing"
```

---

## Task 5: Session tokens

**Files:**
- Create: `apps/server/src/modules/auth/tokens.ts`, `apps/server/src/modules/auth/tokens.test.ts`

**Interfaces:**
- Produces:
  - `generateSessionToken(): string`
  - `hashSessionToken(token: string): string`
  - `SESSION_TTL_MS: number`
  - `sessionExpiry(from?: Date): Date`

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/auth/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
} from "./tokens.js";

describe("session tokens", () => {
  it("generates url-safe tokens with adequate entropy", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url encodes to 43 characters.
    expect(token.length).toBe(43);
  });

  it("generates a distinct token every call", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(seen.size).toBe(200);
  });

  it("hashes deterministically and never returns the raw token", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different tokens", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });

  it("computes expiry from the TTL", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(sessionExpiry(from).getTime()).toBe(from.getTime() + SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/server test tokens`
Expected: FAIL — cannot resolve `./tokens.js`.

- [ ] **Step 3: Create `apps/server/src/modules/auth/tokens.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 bytes of CSPRNG entropy, base64url encoded for cookie safety. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only this hash is stored. The raw token lives in the cookie and nowhere else,
 * so a database dump or SQL-injection read yields nothing usable — the same
 * reasoning that applies to passwords.
 *
 * SHA-256 without a salt is correct here, unlike for passwords: the input is
 * already 256 bits of uniform randomness, so there is nothing to brute-force
 * and per-value salting would only prevent the O(1) lookup this design needs.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @harbor/server test tokens`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(auth): session token generation and hashing"
```

---

## Task 6: Login throttling

**Files:**
- Create: `apps/server/src/modules/auth/throttle.ts`, `apps/server/src/modules/auth/throttle.test.ts`

**Interfaces:**
- Produces:
  - `backoffMs(failedCount: number, freeAttempts?: number): number`
  - `retryAfterSeconds(failedCount, lastFailedAt: Date | null, now?: Date, freeAttempts?: number): number` — 0 when not throttled
  - `class AttemptThrottle` with `record(key: string, now?: Date): void`, `retryAfter(key: string, now?: Date): number`, `reset(key: string): void`
  - `identifierKey(identifier: string): string` — stable hash used to track unknown identifiers without storing them
  - `FREE_ATTEMPTS`, `IP_FREE_ATTEMPTS`, `MAX_BACKOFF_MS`

The store is keyed by an opaque string so the same bounded structure serves two
dimensions: source IP and submitted identifier. Task 12 needs both.

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/auth/throttle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AttemptThrottle,
  FREE_ATTEMPTS,
  IP_FREE_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffMs,
  identifierKey,
  retryAfterSeconds,
} from "./throttle.js";

describe("backoffMs", () => {
  it("allows the first attempts with no delay", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect(backoffMs(i)).toBe(0);
  });

  it("doubles after the free attempts and caps", () => {
    expect(backoffMs(FREE_ATTEMPTS)).toBe(1000);
    expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(2000);
    expect(backoffMs(FREE_ATTEMPTS + 2)).toBe(4000);
    expect(backoffMs(100)).toBe(MAX_BACKOFF_MS);
  });

  it("never exceeds the ceiling", () => {
    for (let i = 0; i < 200; i++) expect(backoffMs(i)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe("retryAfterSeconds", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("is zero while attempts remain free", () => {
    expect(retryAfterSeconds(0, null, at)).toBe(0);
    expect(retryAfterSeconds(FREE_ATTEMPTS - 1, at, at)).toBe(0);
  });

  it("reports remaining seconds inside the window", () => {
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, at)).toBe(4);
    const half = new Date(at.getTime() + 2000);
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, half)).toBe(2);
  });

  it("is zero once the window has elapsed", () => {
    const later = new Date(at.getTime() + 10_000);
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, later)).toBe(0);
  });

  it("is zero when there is no recorded failure", () => {
    expect(retryAfterSeconds(99, null, at)).toBe(0);
  });
});

describe("AttemptThrottle", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("throttles only after its free attempts", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS; i++) t.record("1.2.3.4", at);
    expect(t.retryAfter("1.2.3.4", at)).toBe(1);
  });

  it("tracks keys independently", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("1.1.1.1", at);
    expect(t.retryAfter("1.1.1.1", at)).toBeGreaterThan(0);
    expect(t.retryAfter("2.2.2.2", at)).toBe(0);
  });

  it("resets on success", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("9.9.9.9", at);
    t.reset("9.9.9.9");
    expect(t.retryAfter("9.9.9.9", at)).toBe(0);
  });

  it("evicts the oldest entries past its cap so it cannot grow unbounded", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS, 3);
    for (const ip of ["a", "b", "c", "d"]) {
      for (let i = 0; i < FREE_ATTEMPTS + 1; i++) t.record(ip, at);
    }
    // "a" was evicted when "d" arrived, so it is no longer throttled.
    expect(t.retryAfter("a", at)).toBe(0);
    expect(t.retryAfter("d", at)).toBeGreaterThan(0);
  });

  it("gives the IP dimension a far larger budget than the account dimension", () => {
    // Guards a self-DoS: HARBOR_TRUST_PROXY is easy to misconfigure, and when
    // it is wrong every request appears to come from the reverse proxy. With a
    // shared budget of 3, three bad logins anywhere would lock out the whole
    // installation.
    expect(IP_FREE_ATTEMPTS).toBeGreaterThan(FREE_ATTEMPTS * 5);

    const t = new AttemptThrottle(IP_FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("10.0.0.1", at);
    expect(t.retryAfter("10.0.0.1", at)).toBe(0);
  });
});

describe("identifierKey", () => {
  it("is stable, case-insensitive and never echoes the identifier", () => {
    const key = identifierKey("Owner@Example.com ");
    expect(key).toBe(identifierKey("owner@example.com"));
    expect(key).not.toContain("owner");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/server test throttle`
Expected: FAIL — cannot resolve `./throttle.js`.

- [ ] **Step 3: Create `apps/server/src/modules/auth/throttle.ts`**

```ts
import { createHash } from "node:crypto";

/**
 * The two dimensions get deliberately asymmetric budgets.
 *
 * FREE_ATTEMPTS guards a single account — a targeted password-guessing attack —
 * so it is tight.
 *
 * IP_FREE_ATTEMPTS only blunts broad scanning, and it must stay generous
 * because it is a self-denial-of-service vector: HARBOR_TRUST_PROXY is easy to
 * misconfigure on a self-hosted install, and when it is wrong every request
 * appears to originate from the reverse proxy. Sharing the tight budget would
 * mean three bad logins from anyone locking out the entire installation.
 */
export const FREE_ATTEMPTS = 3;
export const IP_FREE_ATTEMPTS = 20;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
const DEFAULT_CAPACITY = 10_000;

/** Doubling backoff after a few free attempts, capped so nothing locks out. */
export function backoffMs(failedCount: number, freeAttempts: number = FREE_ATTEMPTS): number {
  if (failedCount < freeAttempts) return 0;
  const scaled = BASE_BACKOFF_MS * 2 ** (failedCount - freeAttempts);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

/** Seconds the caller must wait, or 0 when not throttled. */
export function retryAfterSeconds(
  failedCount: number,
  lastFailedAt: Date | null,
  now: Date = new Date(),
  freeAttempts: number = FREE_ATTEMPTS,
): number {
  if (lastFailedAt === null) return 0;
  const window = backoffMs(failedCount, freeAttempts);
  if (window === 0) return 0;
  const remaining = lastFailedAt.getTime() + window - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

/**
 * Stable, non-reversible key for a submitted identifier. Tracking unknown
 * identifiers is what lets login answer 429 identically whether or not the
 * account exists (see Task 12); hashing means the store never holds a list of
 * attempted usernames or email addresses in memory.
 */
export function identifierKey(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
}

interface AttemptEntry {
  count: number;
  lastFailedAt: Date;
}

/**
 * Bounded in-memory failure tracking, keyed by an opaque string so the same
 * structure serves both the source-IP and the unknown-identifier dimension.
 *
 * In memory rather than the database on purpose: a write per failed guess would
 * itself be a denial-of-service vector. State is lost on restart, which is
 * acceptable because per-account throttling — which does persist in
 * `users.failed_login_count` — is what defends a targeted attack.
 *
 * Capacity-bounded with oldest-first eviction so an attacker rotating source
 * addresses or identifiers cannot exhaust memory.
 */
export class AttemptThrottle {
  readonly #entries = new Map<string, AttemptEntry>();
  readonly #freeAttempts: number;
  readonly #capacity: number;

  constructor(freeAttempts: number = FREE_ATTEMPTS, capacity: number = DEFAULT_CAPACITY) {
    this.#freeAttempts = freeAttempts;
    this.#capacity = capacity;
  }

  record(key: string, now: Date = new Date()): void {
    const existing = this.#entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastFailedAt = now;
      // Re-insert to mark as most recently used.
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return;
    }

    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { count: 1, lastFailedAt: now });
  }

  retryAfter(key: string, now: Date = new Date()): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    return retryAfterSeconds(entry.count, entry.lastFailedAt, now, this.#freeAttempts);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @harbor/server test throttle`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(auth): login throttling with bounded backoff"
```

---

## Task 7: Cookies

**Files:**
- Create: `apps/server/src/modules/auth/cookies.ts`, `apps/server/src/modules/auth/cookies.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: `SESSION_TTL_MS` from Task 5
- Produces:
  - `SESSION_COOKIE = "harbor_session"`
  - `cookieOptions(baseUrl: string): CookieSerializeOptions`
  - `setSessionCookie(reply, token, baseUrl): void`
  - `clearSessionCookie(reply, baseUrl): void`

- [ ] **Step 1: Add the dependency**

Add to `apps/server/package.json` `dependencies`:

```json
    "@fastify/cookie": "11.1.2",
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing test**

`apps/server/src/modules/auth/cookies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "./tokens.js";
import { cookieOptions } from "./cookies.js";

describe("cookieOptions", () => {
  it("marks Secure for an https base URL", () => {
    expect(cookieOptions("https://harbor.example.com").secure).toBe(true);
  });

  it("does NOT mark Secure for plain http", () => {
    // Hardcoding Secure=true breaks local development: the browser silently
    // drops the cookie and login appears to succeed while nothing persists.
    expect(cookieOptions("http://localhost:5173").secure).toBe(false);
  });

  it("always sets HttpOnly, SameSite=Lax and root path", () => {
    const o = cookieOptions("https://harbor.example.com");
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
  });

  it("expires in step with the session TTL", () => {
    expect(cookieOptions("https://harbor.example.com").maxAge).toBe(SESSION_TTL_MS / 1000);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @harbor/server test cookies`
Expected: FAIL — cannot resolve `./cookies.js`.

- [ ] **Step 4: Create `apps/server/src/modules/auth/cookies.ts`**

```ts
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import { SESSION_TTL_MS } from "./tokens.js";

export const SESSION_COOKIE = "harbor_session";

/**
 * `secure` is derived from the deployment's own base URL rather than hardcoded.
 * Hardcoding true breaks plain-http local development in a confusing way: the
 * browser drops the cookie silently, so login looks successful but no session
 * persists. Phase 1 already constrains HARBOR_BASE_URL to http or https.
 */
export function cookieOptions(baseUrl: string): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, baseUrl: string): void {
  void reply.setCookie(SESSION_COOKIE, token, cookieOptions(baseUrl));
}

/** Path must match the one used when setting, or the browser keeps the original. */
export function clearSessionCookie(reply: FastifyReply, baseUrl: string): void {
  void reply.clearCookie(SESSION_COOKIE, { ...cookieOptions(baseUrl), maxAge: 0 });
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/server test cookies`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): session cookie helpers with derived Secure flag"
```

---

## Task 8: The authentication guard

**Files:**
- Create: `apps/server/src/plugins/auth.ts`, `apps/server/src/plugins/auth.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/test-helpers.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `hashSessionToken`, `findSessionByTokenHash`, `touchSession`, `deleteSession`
- Produces:
  - `authGuard` Fastify plugin
  - `PUBLIC_ROUTES: ReadonlySet<string>`
  - `request.user: AuthenticatedUser | null` and `request.session: Session | null` decorators

- [ ] **Step 1: Write the failing test**

This is the most important test in Phase 2a. It is the executable form of the fail-closed guarantee.

`apps/server/src/plugins/auth.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const VALID_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "owner",
  email: "owner@example.com",
  role: "owner" as const,
  passwordHash: "x",
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function validSession() {
  return {
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: VALID_USER.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user: VALID_USER,
  };
}

describe("auth guard", () => {
  it("allows every allowlisted public route without a session", async () => {
    const app = await buildTestApp({ ready: true });
    for (const url of [
      "/api/v1/health",
      "/api/v1/health/live",
      "/api/v1/health/ready",
      "/api/v1/installation/state",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} should be public`).not.toBe(401);
    }
    await app.close();
  });

  it("FAILS CLOSED: a route registered without allowlisting requires a session", async () => {
    // The whole design rests on this. A new route is protected by default;
    // nobody has to remember to add a guard.
    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/brand-new-route", async () => ({ secret: "value" }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/brand-new-route" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(res.body).not.toContain("value");
    await app.close();
  });

  it("rejects a request whose cookie matches no session", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an expired session and does not leak the user", async () => {
    const expired = validSession();
    expired.session.expiresAt = new Date(Date.now() - 1000);
    vi.mocked(findSessionByTokenHash).mockResolvedValue(expired);

    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async (request) => ({ user: request.user }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("owner");
    await app.close();
  });

  it("admits a valid session and decorates request.user", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(validSession());

    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async (request) => ({ user: request.user }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { username: "owner", role: "owner", email: "owner@example.com" },
    });
    // request.user must never carry the hash.
    expect(res.body).not.toContain("passwordHash");
    await app.close();
  });

  it("leaves non-API paths public so the SPA shell can load", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("yields 503, not 500, when Harbor is not ready and a cookie is present", async () => {
    // The guard runs at root, ahead of the API scope's readiness gate. Without
    // its own readiness check it would query a database that may be down and
    // surface INTERNAL_ERROR, breaking the Phase 1 contract that non-health API
    // routes answer 503 SERVICE_UNAVAILABLE while starting up.
    vi.mocked(findSessionByTokenHash).mockClear();
    const app = await buildTestApp({ ready: false });
    app.get("/api/v1/guarded", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(findSessionByTokenHash).not.toHaveBeenCalled();
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/server test auth`
Expected: FAIL — cannot resolve `../plugins/auth.js`, and the fail-closed test returns 200 instead of 401.

- [ ] **Step 3: Create `apps/server/src/plugins/auth.ts`**

```ts
import { findSessionByTokenHash, touchSession, type Session } from "@harbor/database";
import { API_PREFIX, type ApiErrorBody, type AuthenticatedUser } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "../modules/auth/cookies.js";
import { hashSessionToken } from "../modules/auth/tokens.js";
import { isReady } from "../state.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
    session: Session | null;
  }
}

/**
 * Exact "METHOD /path" matches only — never prefixes. A prefix entry such as
 * "/api/v1/auth" would also expose "/api/v1/auth/sessions".
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  `GET ${API_PREFIX}/health`,
  `GET ${API_PREFIX}/health/live`,
  `GET ${API_PREFIX}/health/ready`,
  `GET ${API_PREFIX}/installation/state`,
  `POST ${API_PREFIX}/setup`,
  `POST ${API_PREFIX}/auth/login`,
  // Logout is public on purpose: an expired or already-revoked session must
  // still be able to clear its cookie. Guarding it would 401 before the handler
  // runs, leaving a stale cookie in the browser forever. The handler is
  // idempotent and reveals nothing (see Task 12).
  `POST ${API_PREFIX}/auth/logout`,
]);

function unauthorized(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
      requestId: request.id,
    },
  };
  return reply.status(401).send(body);
}

function notReady(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Harbor is starting up. Try again shortly.",
      requestId: request.id,
    },
  };
  return reply.status(503).send(body);
}

const authGuardPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("session", null);

  fastify.addHook("onRequest", async (request, reply) => {
    // Routing runs before onRequest, so the matched route pattern is known here.
    const routeUrl = request.routeOptions.url;

    // No matched route: the 404 handlers own the response.
    if (routeUrl === undefined) return;

    // Static assets and the SPA shell are public by nature.
    if (!routeUrl.startsWith(API_PREFIX)) return;

    if (PUBLIC_ROUTES.has(`${request.method} ${routeUrl}`)) return;

    // This plugin is registered at root, so its hook runs BEFORE the API
    // scope's readiness gate. Without this check the session lookup below would
    // hit a database that may be unreachable or unmigrated and surface a 500,
    // overriding Phase 1's contract that non-health API routes answer 503 while
    // Harbor is starting. Returning the reply here (rather than falling
    // through) keeps the guard fail-closed: the request never reaches a handler.
    // Public routes are checked first, so health and readiness probes — the
    // paths that actually refresh readiness — are unaffected.
    if (!isReady(fastify.state)) return notReady(request, reply);

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return unauthorized(request, reply);

    const found = await findSessionByTokenHash(fastify.db, hashSessionToken(token));
    if (!found) return unauthorized(request, reply);

    if (found.session.expiresAt.getTime() <= Date.now()) {
      return unauthorized(request, reply);
    }

    request.session = found.session;
    request.user = {
      id: found.user.id,
      username: found.user.username,
      email: found.user.email,
      role: found.user.role,
    };

    // Fire-and-forget: a failed timestamp refresh must not fail the request.
    void touchSession(fastify.db, found.session.id).catch((error: unknown) => {
      request.log.warn({ err: error }, "failed to refresh session last_seen_at");
    });
  });
};

export const authGuard = fp(authGuardPlugin, { name: "harbor-auth-guard", fastify: "5.x" });
```

- [ ] **Step 4: Register in `apps/server/src/app.ts`**

Add the imports:

```ts
import fastifyCookie from "@fastify/cookie";
import { authGuard } from "./plugins/auth.js";
```

Register cookie support and the guard **before** the API scope, so the guard's `onRequest` hook is installed ahead of any route:

```ts
  await app.register(fastifyCookie);
  await app.register(authGuard);
```

Place these immediately after the `errors` plugin registration and before `app.register(async (api) => {...}, { prefix: API_PREFIX })`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/server test`
Expected: PASS — 7 new guard tests plus all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): fail-closed authentication guard"
```

---

## Task 9: Origin check on mutating requests

**Files:**
- Create: `apps/server/src/plugins/origin.ts`, `apps/server/src/plugins/origin.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Produces: `originCheck` Fastify plugin

- [ ] **Step 1: Write the failing test**

`apps/server/src/plugins/origin.test.ts`:

The probe route is not on the public allowlist, so the auth guard would answer
401 before the origin check ever mattered — and `not.toBe(403)` is satisfied by
a 401, which would let the whole allow-branch of `origin.ts` be deleted with the
suite still green. So this file mocks a valid session, sends the cookie, and
asserts a hard `200` on the allow paths.

```ts
import type * as HarborDatabase from "@harbor/database";
import { describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const SESSION_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "owner",
  email: "owner@example.com",
  role: "owner" as const,
  passwordHash: "x",
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// testEnv sets HARBOR_BASE_URL to http://localhost:3000
async function build() {
  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: SESSION_USER.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user: SESSION_USER,
  });
  const app = await buildTestApp({ ready: true });
  app.post("/api/v1/mutating-probe", async () => ({ ok: true }));
  await app.ready();
  return app;
}

const COOKIES = { harbor_session: "token" };

describe("origin check", () => {
  it("allows a same-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a cross-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows a request with no Origin (non-browser client)", async () => {
    // A browser always sends Origin on a cross-site POST, so its absence means
    // a non-browser caller, which carries no ambient cookies and so no CSRF risk.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("falls back to Referer when Origin is absent", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { referer: "https://evil.example.com/page" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("does not check safe methods", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/server test origin`
Expected: FAIL — cannot resolve `./origin.js`.

- [ ] **Step 3: Create `apps/server/src/plugins/origin.ts`**

```ts
import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Second layer behind SameSite=Lax. Lax already stops browsers attaching the
 * session cookie to cross-site state-changing requests; this catches the
 * residue without the plumbing of a CSRF token.
 *
 * A missing Origin is allowed on purpose: browsers always send it on cross-site
 * mutations, so its absence means a non-browser client, which carries no
 * ambient cookie and therefore cannot be the victim of CSRF. Rejecting it would
 * break curl and API clients for no security gain.
 */
const originCheckPlugin: FastifyPluginAsync<{ baseUrl: string }> = async (fastify, opts) => {
  const expected = new URL(opts.baseUrl).origin;

  fastify.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    const routeUrl = request.routeOptions.url;
    if (routeUrl === undefined || !routeUrl.startsWith(API_PREFIX)) return;

    const headers = request.headers;
    const claimed =
      originOf(typeof headers.origin === "string" ? headers.origin : undefined) ??
      originOf(typeof headers.referer === "string" ? headers.referer : undefined);

    if (claimed === null) return;
    if (claimed === expected) return;

    request.log.warn({ claimed, expected }, "rejected cross-origin mutating request");
    const body: ApiErrorBody = {
      error: {
        code: "VALIDATION_FAILED",
        message: "Cross-origin request rejected.",
        requestId: request.id,
      },
    };
    return reply.status(403).send(body);
  });
};

export const originCheck = fp(originCheckPlugin, { name: "harbor-origin-check", fastify: "5.x" });
```

- [ ] **Step 4: Register in `apps/server/src/app.ts`**

Add the import and register it immediately before `authGuard`:

```ts
import { originCheck } from "./plugins/origin.js";
...
  await app.register(originCheck, { baseUrl: deps.env.HARBOR_BASE_URL });
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/server test`
Expected: PASS — 5 new origin tests plus everything prior.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): reject cross-origin mutating requests"
```

---

## Task 10: Setup transaction

**Files:**
- Create: `packages/database/src/setup.ts`, `packages/database/src/setup.test.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**
- Consumes: `installation`, `users`, `Db`
- Produces: `completeSetupWithOwner(db, input): Promise<User>` where `input = { serverName, language, username, email, passwordHash }`; throws `SetupAlreadyCompleteError`

- [ ] **Step 1: Write the failing test**

`packages/database/src/setup.test.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClient, createClient, type Db } from "./client.js";
import { ensureInstallationRow, getInstallation } from "./installation.js";
import { runMigrations } from "./migrate.js";
import { SetupAlreadyCompleteError, completeSetupWithOwner } from "./setup.js";

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
  await db.execute(sql`truncate table sessions, users restart identity cascade`);
  await db.execute(sql`update installation set setup_completed_at = null, server_name = null, language = null`);
  await ensureInstallationRow(db);
});

const input = {
  serverName: "Test Harbor",
  language: "en",
  username: "owner",
  email: "owner@example.com",
  passwordHash: "$argon2id$fake",
};

describe("completeSetupWithOwner", () => {
  it("creates the owner and marks setup complete", async () => {
    const owner = await completeSetupWithOwner(db, input);
    expect(owner.role).toBe("owner");
    expect(owner.username).toBe("owner");

    const record = await getInstallation(db);
    expect(record?.setupCompletedAt).toBeInstanceOf(Date);
    expect(record?.serverName).toBe("Test Harbor");
    expect(record?.language).toBe("en");
  });

  it("rejects a second attempt", async () => {
    await completeSetupWithOwner(db, input);
    await expect(
      completeSetupWithOwner(db, { ...input, username: "second" }),
    ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);

    const count = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
    expect(count[0]?.count).toBe("1");
  });

  it("produces exactly one owner under concurrent attempts", async () => {
    const results = await Promise.allSettled([
      completeSetupWithOwner(db, { ...input, username: "racer-a" }),
      completeSetupWithOwner(db, { ...input, username: "racer-b", email: "b@example.com" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const count = await db.execute<{ count: string }>(sql`select count(*)::text as count from users`);
    expect(count[0]?.count).toBe("1");
  });

  it("ROLLS BACK to a retryable state when user creation fails", async () => {
    // A completed install with no owner would be unrecoverable. Force the
    // insert to fail and assert setup is still incomplete.
    await db.execute(sql`insert into users (username, password_hash, role) values ('taken', 'x', 'user')`);

    await expect(completeSetupWithOwner(db, { ...input, username: "taken" })).rejects.toThrow();

    const record = await getInstallation(db);
    expect(record?.setupCompletedAt).toBeNull();

    // And the install can still be completed afterwards.
    const owner = await completeSetupWithOwner(db, input);
    expect(owner.role).toBe("owner");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/database test setup`
Expected: FAIL — cannot resolve `./setup.js`.

- [ ] **Step 3: Create `packages/database/src/setup.ts`**

```ts
import { isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { installation, users, type User } from "./schema.js";

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Setup has already been completed.");
    this.name = "SetupAlreadyCompleteError";
  }
}

export interface CompleteSetupInput {
  serverName: string;
  language: string;
  username: string;
  email: string;
  passwordHash: string;
}

/**
 * Marks setup complete and creates the owner in one transaction, update-first.
 *
 * Update-first means the race guard runs before any other work: the conditional
 * UPDATE returns zero rows for every caller but the winner. Doing the insert
 * first would risk a completed install with no owner, which is unrecoverable.
 *
 * Throwing inside the callback rolls the transaction back, so any failure —
 * duplicate username, constraint violation, crash — leaves setup incomplete
 * and therefore retryable.
 *
 * The password must already be hashed. Hashing is deliberately kept outside so
 * a ~100ms Argon2 computation does not hold the transaction open.
 */
export async function completeSetupWithOwner(db: Db, input: CompleteSetupInput): Promise<User> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(installation)
      .set({
        setupCompletedAt: new Date(),
        serverName: input.serverName,
        language: input.language,
      })
      .where(isNull(installation.setupCompletedAt))
      .returning();

    if (claimed.length === 0) throw new SetupAlreadyCompleteError();

    const created = await tx
      .insert(users)
      .values({
        username: input.username.trim().toLowerCase(),
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        role: "owner",
      })
      .returning();

    const owner = created[0];
    if (!owner) throw new Error("owner insert returned no row");
    return owner;
  });
}
```

- [ ] **Step 4: Export it**

Add to `packages/database/src/index.ts`:

```ts
export * from "./setup.js";
```

- [ ] **Step 5: Delete the superseded `completeSetup`**

Phase 1's `completeSetup(db)` marked the installation complete without creating
an owner. `completeSetupWithOwner` is now the only path that may do that, and
leaving both invites someone to call the one that produces a completed install
with no owner — exactly the unrecoverable state Step 3 is designed to prevent.

In `packages/database/src/installation.ts`: delete the `completeSetup` function
and its doc comment. Drop `isNull` from the `drizzle-orm` import and
`Installation` from the type import if nothing else in the file uses them.

In `packages/database/src/migrate.test.ts`: drop `completeSetup` from the
`./installation.js` import and delete the first test in the
`describe("completeSetup", ...)` block — the one asserting a concurrent race
produces one winner; `setup.test.ts` now covers that behaviour. **Keep** the
second test in that block ("rejects a second installation row at the database
level") — it exercises the singleton constraint, not `completeSetup`. Rename the
block to `describe("installation row", ...)`.

Run `pnpm --filter @harbor/database lint` and confirm no unused-import errors.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @harbor/database test`
Expected: PASS — 4 setup tests plus everything prior, minus the one deleted
`completeSetup` test.

- [ ] **Step 7: Commit**

```bash
git add packages/database
git commit -m "feat(database): atomic owner creation and setup completion"
```

---

## Task 11: Setup route

**Files:**
- Create: `apps/server/src/modules/setup/routes.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 7, 10
- Produces: `setupRoutes` Fastify plugin

- [ ] **Step 1: Create `apps/server/src/modules/setup/routes.ts`**

```ts
import {
  SetupAlreadyCompleteError,
  completeSetupWithOwner,
  createSession,
  isSetupComplete,
} from "@harbor/database";
import type { AuthenticatedUser } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { setSessionCookie } from "../auth/cookies.js";
import { hashPassword } from "../auth/passwords.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "../auth/tokens.js";

const SetupSchema = z.object({
  language: z.string().min(2).max(16),
  serverName: z.string().min(1).max(100),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.email(),
  password: z.string().min(12).max(200),
});

export const setupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/setup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply): Promise<{ user: AuthenticatedUser }> => {
      const parsed = SetupSchema.safeParse(request.body);
      if (!parsed.success) {
        // Field paths only — the payload contains a password.
        throw new HarborError("VALIDATION_FAILED", "Invalid setup details.", 400);
      }

      if (await isSetupComplete(fastify.db)) {
        throw new HarborError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 409);
      }

      // Hash outside the transaction so Argon2 does not hold it open.
      const passwordHash = await hashPassword(parsed.data.password);

      let owner;
      try {
        owner = await completeSetupWithOwner(fastify.db, {
          serverName: parsed.data.serverName,
          language: parsed.data.language,
          username: parsed.data.username,
          email: parsed.data.email,
          passwordHash,
        });
      } catch (error) {
        if (error instanceof SetupAlreadyCompleteError) {
          throw new HarborError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 409);
        }
        throw error;
      }

      const token = generateSessionToken();
      await createSession(fastify.db, {
        userId: owner.id,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiry(),
        userAgent: request.headers["user-agent"] ?? null,
        ip: request.ip,
      });
      setSessionCookie(reply, token, fastify.env.HARBOR_BASE_URL);

      fastify.log.info({ userId: owner.id }, "setup completed, owner created");
      void reply.status(201);
      return {
        user: { id: owner.id, username: owner.username, email: owner.email, role: owner.role },
      };
    },
  );
};
```

- [ ] **Step 2: Register it in `apps/server/src/app.ts`**

Add the import and register inside the existing `{ prefix: API_PREFIX }` scope,
after `installationRoutes`:

```ts
import { setupRoutes } from "./modules/setup/routes.js";
...
      await api.register(setupRoutes);
```

- [ ] **Step 3: Verify against a real database**

Start Postgres, build, boot the server (see `docs/development.md` for the exported variables), then:

```bash
curl -si -X POST localhost:3000/api/v1/setup -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"language":"en","serverName":"Test","username":"owner","email":"o@example.com","password":"correct-horse-battery"}'
```

Confirm: `201`, a `set-cookie` carrying `harbor_session` with `HttpOnly` and `SameSite=Lax`, and a body containing the user without any hash.

Keep the cookie value — Task 12 uses it. Then confirm repeat setup is refused:

```bash
curl -si -X POST localhost:3000/api/v1/setup -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' -d '{"language":"en","serverName":"x","username":"a","email":"a@b.co","password":"correct-horse-battery"}' | head -1
```

Expected: `409`.

Report the real output. Leave the container running for Task 12.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @harbor/server test`
Expected: PASS — everything prior still green.

```bash
git add apps/server
git commit -m "feat(setup): owner setup route"
```

---

## Task 12: Auth routes

**Files:**
- Create: `apps/server/src/modules/auth/routes.ts`, `apps/server/src/modules/auth/routes.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Tasks 2-8
- Produces: `authRoutes` Fastify plugin serving `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`

- [ ] **Step 1: Create `apps/server/src/modules/auth/routes.ts`**

**Read the ordering comment in the handler before writing it.** The sequence is
load-bearing: the throttle decision must be made *before* the code branches on
whether the account exists, or a throttled account answers 429 while an unknown
identifier answers 401 — an account-enumeration oracle that the per-IP throttle
does not mask, because IP state is per-process and in-memory while
`failed_login_count` persists in the database.

```ts
import {
  createSession,
  deleteSession,
  findSessionByTokenHash,
  findUserByIdentifier,
  recordFailedLogin,
  resetFailedLogins,
} from "@harbor/database";
import type { AuthenticatedUser } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from "./cookies.js";
import { verifyAgainstDummy, verifyPassword } from "./passwords.js";
import {
  AttemptThrottle,
  FREE_ATTEMPTS,
  IP_FREE_ATTEMPTS,
  identifierKey,
  retryAfterSeconds,
} from "./throttle.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "./tokens.js";

const LoginSchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});

/** One generic message for both unknown-user and wrong-password. */
const INVALID_CREDENTIALS = "Invalid credentials.";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Two dimensions, two budgets. The IP dimension is generous (see throttle.ts)
   * because a misconfigured HARBOR_TRUST_PROXY collapses every client onto one
   * address.
   *
   * The unknown-identifier store exists solely so the 429 branch is reachable
   * when no account matches. Without it, a throttled real account answers 429
   * while an unknown identifier answers 401, and that difference enumerates
   * accounts. It is deliberately keyed by a SHA-256 of the identifier so the
   * process never holds a list of attempted usernames.
   */
  const ipThrottle = new AttemptThrottle(IP_FREE_ATTEMPTS);
  const unknownIdentifiers = new AttemptThrottle(FREE_ATTEMPTS);

  fastify.post(
    "/auth/login",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply): Promise<{ user: AuthenticatedUser }> => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", "Invalid credentials payload.", 400);
      }

      const ipWait = ipThrottle.retryAfter(request.ip);
      if (ipWait > 0) {
        void reply.header("Retry-After", String(ipWait));
        throw new HarborError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
      }

      const user = await findUserByIdentifier(fastify.db, parsed.data.identifier);
      const key = identifierKey(parsed.data.identifier);

      // Decide the backoff BEFORE branching on whether the account exists.
      // Existing accounts read the persistent counter; unknown identifiers read
      // the in-memory store. Both feed the same response below, so a throttled
      // account and a throttled unknown identifier are indistinguishable.
      const identifierWait = user
        ? retryAfterSeconds(user.failedLoginCount, user.lastFailedLoginAt)
        : unknownIdentifiers.retryAfter(key);

      if (identifierWait > 0) {
        void reply.header("Retry-After", String(identifierWait));
        throw new HarborError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
      }

      // Constant work either way, so response timing does not reveal existence.
      const authenticated = user
        ? await verifyPassword(user.passwordHash, parsed.data.password)
        : await verifyAgainstDummy().then(() => false);

      if (!authenticated) {
        if (user) {
          await recordFailedLogin(fastify.db, user.id);
          fastify.log.warn({ userId: user.id }, "failed login");
        } else {
          unknownIdentifiers.record(key);
          // No identifier in the log line — it may be someone's email address.
          fastify.log.warn("failed login for an unknown identifier");
        }
        ipThrottle.record(request.ip);
        throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);
      }

      // Unreachable — `authenticated` is only true when a user was found — but
      // TypeScript cannot narrow `user` from it, and an explicit fail-closed
      // branch is better than a non-null assertion in an auth path.
      if (!user) throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);

      await resetFailedLogins(fastify.db, user.id);
      unknownIdentifiers.reset(key);
      ipThrottle.reset(request.ip);

      const token = generateSessionToken();
      await createSession(fastify.db, {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        expiresAt: sessionExpiry(),
        userAgent: request.headers["user-agent"] ?? null,
        ip: request.ip,
      });
      setSessionCookie(reply, token, fastify.env.HARBOR_BASE_URL);

      fastify.log.info({ userId: user.id }, "login succeeded");
      return {
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
      };
    },
  );

  /**
   * Idempotent and allowlisted as public (see PUBLIC_ROUTES in plugins/auth.ts).
   * If logout were guarded, an expired or already-revoked session would get a
   * 401 and the browser would keep its stale cookie forever — the one state
   * where a user most needs logout to work. So: always clear the cookie, delete
   * the row only if one exists, and always answer 204. It reveals nothing,
   * because the response is the same whether or not the token matched.
   *
   * The session is resolved from the cookie rather than `request.session`,
   * which the guard leaves null on a public route.
   */
  fastify.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const found = await findSessionByTokenHash(fastify.db, hashSessionToken(token));
      if (found) await deleteSession(fastify.db, found.session.id);
    }
    clearSessionCookie(reply, fastify.env.HARBOR_BASE_URL);
    void reply.status(204);
    return null;
  });

  fastify.get("/auth/me", async (request): Promise<{ user: AuthenticatedUser }> => {
    // The guard already rejects unauthenticated requests, so this is defence in
    // depth against /auth/me ever being added to the public allowlist by mistake.
    if (!request.user) throw new HarborError("UNAUTHENTICATED", "Authentication required.", 401);
    return { user: request.user };
  });
};
```

This module does not import `hashPassword` — only `verifyPassword` and
`verifyAgainstDummy`. Hashing happens in the setup route (Task 11) and, later,
in user management. Root ESLint treats `no-unused-vars` as an error, so an
unused import fails `pnpm lint`.

- [ ] **Step 2: Register it in `apps/server/src/app.ts`**

Add the import and register inside the existing `{ prefix: API_PREFIX }` scope, after `setupRoutes`:

```ts
import { authRoutes } from "./modules/auth/routes.js";
...
      await api.register(authRoutes);
```

- [ ] **Step 3: Write the route tests**

`apps/server/src/modules/auth/routes.test.ts`:

```ts
import type * as HarborDatabase from "@harbor/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test-helpers.js";
import { hashPassword } from "./passwords.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    findUserByIdentifier: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    recordFailedLogin: vi.fn(),
    resetFailedLogins: vi.fn(),
    findSessionByTokenHash: vi.fn(),
    touchSession: vi.fn(),
  };
});

const db = await import("@harbor/database");

const PASSWORD = "correct-horse-battery";
let storedHash: string;

const user = () => ({
  id: "33333333-3333-3333-3333-333333333333",
  username: "owner",
  email: "owner@example.com",
  passwordHash: storedHash,
  role: "owner" as const,
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const validSession = () => ({
  session: {
    id: "44444444-4444-4444-4444-444444444444",
    userId: user().id,
    tokenHash: "hash",
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    userAgent: null,
    ip: null,
    createdAt: new Date(),
  },
  user: user(),
});

beforeEach(async () => {
  vi.clearAllMocks();
  storedHash ??= await hashPassword(PASSWORD);
  vi.mocked(db.createSession).mockResolvedValue({} as never);
  vi.mocked(db.deleteSession).mockResolvedValue(undefined);
  vi.mocked(db.recordFailedLogin).mockResolvedValue(1);
  vi.mocked(db.resetFailedLogins).mockResolvedValue(undefined);
});

async function login(body: unknown, app: Awaited<ReturnType<typeof buildTestApp>>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: body,
    headers: { origin: "http://localhost:3000" },
  });
}

describe("POST /api/v1/auth/login", () => {
  it("issues a session cookie for correct credentials", async () => {
    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const app = await buildTestApp({ ready: true });

    const res = await login({ identifier: "owner", password: PASSWORD }, app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: "owner", role: "owner" } });

    const cookie = res.cookies.find((c) => c.name === "harbor_session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("lax");
    expect(res.body).not.toContain("passwordHash");
    await app.close();
  });

  it("returns an identical response for unknown user and wrong password", async () => {
    const app = await buildTestApp({ ready: true });

    vi.mocked(db.findUserByIdentifier).mockResolvedValue(null);
    const unknown = await login({ identifier: "ghost", password: "whatever" }, app);

    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const wrong = await login({ identifier: "owner", password: "wrong-password" }, app);

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    // Bodies differ only by requestId, so compare the meaningful parts.
    const strip = (b: string) => b.replace(/"requestId":"[^"]*"/, "");
    expect(strip(unknown.body)).toBe(strip(wrong.body));
    await app.close();
  });

  it("returns the same status for a throttled account and an unknown identifier", async () => {
    // THIS TEST IS THE POINT OF THE HANDLER'S ORDERING — do not "simplify" it
    // back to comparing two un-throttled responses. The 401-vs-401 case above
    // passes no matter how the handler is written, because with
    // failedLoginCount: 0 no 429 is reachable at all. The enumeration oracle
    // lives on the throttled path: if the backoff is computed only after the
    // `if (!user)` branch, a throttled real account answers 429 + Retry-After
    // while an unknown identifier answers 401, and anyone can tell which
    // usernames exist by mistyping a password three times.
    const app = await buildTestApp({ ready: true });

    vi.mocked(db.findUserByIdentifier).mockResolvedValue({
      ...user(),
      failedLoginCount: 8,
      lastFailedLoginAt: new Date(),
    });
    const throttled = await login({ identifier: "owner", password: "wrong" }, app);

    // Drive the unknown identifier into the same throttled state.
    vi.mocked(db.findUserByIdentifier).mockResolvedValue(null);
    for (let i = 0; i < 8; i++) await login({ identifier: "ghost", password: "wrong" }, app);
    const unknown = await login({ identifier: "ghost", password: "wrong" }, app);

    expect(throttled.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(throttled.statusCode);
    expect(unknown.headers["retry-after"]).toBe(throttled.headers["retry-after"]);
    await app.close();
  });

  it("records a failed attempt on a wrong password", async () => {
    vi.mocked(db.findUserByIdentifier).mockResolvedValue(user());
    const app = await buildTestApp({ ready: true });
    await login({ identifier: "owner", password: "nope" }, app);
    expect(db.recordFailedLogin).toHaveBeenCalledOnce();
    await app.close();
  });

  it("returns 429 with Retry-After once the account is throttled", async () => {
    vi.mocked(db.findUserByIdentifier).mockResolvedValue({
      ...user(),
      failedLoginCount: 8,
      lastFailedLoginAt: new Date(),
    });
    const app = await buildTestApp({ ready: true });

    const res = await login({ identifier: "owner", password: PASSWORD }, app);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects a malformed payload without leaking the value", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await login({ identifier: "", password: "hunter2" }, app);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("hunter2");
    await app.close();
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("succeeds and clears the cookie even with an expired or unknown session", async () => {
    // Logout is idempotent and allowlisted. If it were guarded, an expired
    // session would get 401 and the browser would keep the stale cookie
    // forever — and the web client, which does not inspect res.ok, would
    // cheerfully report a successful sign-out.
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { harbor_session: "expired-or-revoked" },
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === "harbor_session");
    expect(cleared).toBeDefined();
    expect(cleared?.value).toBe("");
    expect(db.deleteSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes the session row when the cookie matches one", async () => {
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(validSession());
    const app = await buildTestApp({ ready: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { harbor_session: "token" },
      headers: { origin: "http://localhost:3000" },
    });

    expect(res.statusCode).toBe(204);
    expect(db.deleteSession).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe("GET /api/v1/auth/me", () => {
  it("requires authentication", async () => {
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @harbor/server test`
Expected: PASS — all new route tests plus everything prior.

- [ ] **Step 5: Verify against a real database**

Using the server and the owner cookie from Task 11 Step 3:

```bash
curl -s localhost:3000/api/v1/auth/me -b "harbor_session=<token from Task 11>"
curl -si -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"identifier":"owner","password":"correct-horse-battery"}' | head -1
curl -si -X POST localhost:3000/api/v1/auth/logout -H 'origin: http://localhost:3000' \
  -b "harbor_session=definitely-not-a-real-token" | head -1
```

Expected: `auth/me` returns the owner; login returns `200` with a fresh
`set-cookie`; logout with a bogus cookie returns `204` and still sends a
clearing `set-cookie`.

Report the real output. Clean up the container afterwards.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): login, logout and me routes"
```

---

## Task 13: Web — setup wizard and login

**Files:**
- Create: `apps/web/src/auth.ts`, `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/pages/Setup.tsx`, `apps/web/src/routes.tsx`, `apps/web/src/api.ts`

**Interfaces:**
- Consumes: `POST /api/v1/setup`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`
- Produces: `useCurrentUser()`, `useSetup()`, `useLogin()`, `useLogout()`

Remember: `apps/web` uses **extensionless** relative imports.

- [ ] **Step 1: Create `apps/web/src/auth.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthenticatedUser, LoginRequest, SetupRequest } from "@harbor/shared";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(parsed?.error?.message ?? "Request failed.");
  }
  return (await res.json()) as T;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async (): Promise<AuthenticatedUser | null> => {
      const res = await fetch("/api/v1/auth/me");
      if (res.status === 401) return null;
      if (!res.ok) throw new Error("Failed to load the current user.");
      const body = (await res.json()) as { user: AuthenticatedUser };
      return body.user;
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetupRequest) =>
      post<{ user: AuthenticatedUser }>("/api/v1/setup", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["installation-state"] });
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) =>
      post<{ user: AuthenticatedUser }>("/api/v1/auth/login", input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    },
    onSuccess: () => queryClient.clear(),
  });
}
```

- [ ] **Step 2: Replace `apps/web/src/pages/Setup.tsx`**

```tsx
import { type FormEvent, type JSX, useState } from "react";
import { useSetup } from "../auth";

export function Setup(): JSX.Element {
  const setup = useSetup();
  const [form, setForm] = useState({
    language: "en",
    serverName: "",
    username: "",
    email: "",
    password: "",
  });

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setup.mutate(form);
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-card bg-harbor-900 p-8">
        <h1 className="font-display text-2xl">Welcome to Harbor</h1>
        <p className="mt-2 text-sm opacity-80">
          Create the owner account for this server.
        </p>

        <label className="mt-6 block text-sm" htmlFor="serverName">
          Server name
        </label>
        <input
          id="serverName"
          required
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          {...field("serverName")}
        />

        <label className="mt-4 block text-sm" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          required
          minLength={3}
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          {...field("username")}
        />

        <label className="mt-4 block text-sm" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          {...field("email")}
        />

        <label className="mt-4 block text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={12}
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          {...field("password")}
        />
        <p className="mt-1 text-xs opacity-60">At least 12 characters.</p>

        {setup.isError && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {setup.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={setup.isPending}
          className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
        >
          {setup.isPending ? "Creating…" : "Create owner account"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create `apps/web/src/pages/Login.tsx`**

```tsx
import { type FormEvent, type JSX, useState } from "react";
import { useLogin } from "../auth";

export function Login(): JSX.Element {
  const login = useLogin();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    login.mutate({ identifier, password });
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-card bg-harbor-900 p-8">
        <h1 className="font-display text-2xl">Sign in to Harbor</h1>

        <label className="mt-6 block text-sm" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          required
          autoComplete="username"
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />

        <label className="mt-4 block text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded bg-harbor-950 p-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {login.isError && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {login.error.message}
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded bg-accent-500 p-2 font-medium disabled:opacity-50"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Update `apps/web/src/routes.tsx`**

Add a `/login` route and gate `/home` on an authenticated user. Replace the file's `RootLayout` and router with:

```tsx
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { fetchInstallationState } from "./api";
import { useCurrentUser } from "./auth";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Setup } from "./pages/Setup";

function useInstallationState() {
  return useQuery({
    queryKey: ["installation-state"],
    queryFn: ({ signal }) => fetchInstallationState(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 2,
  });
}

function RootLayout(): JSX.Element {
  const location = useLocation();
  const install = useInstallationState();
  const currentUser = useCurrentUser();

  if (install.isPending || currentUser.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="status">
        Starting Harbor…
      </main>
    );
  }

  if (install.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center" role="alert">
        Harbor is unavailable. Check the server logs.
      </main>
    );
  }

  const onSetup = location.pathname === "/setup";
  const onLogin = location.pathname === "/login";
  const signedIn = currentUser.data !== null && currentUser.data !== undefined;

  if (!install.data.setupComplete) {
    return onSetup ? <Outlet /> : <Navigate to="/setup" replace />;
  }
  if (onSetup) return <Navigate to={signedIn ? "/home" : "/login"} replace />;
  if (!signedIn) return onLogin ? <Outlet /> : <Navigate to="/login" replace />;
  if (onLogin) return <Navigate to="/home" replace />;

  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, Component: () => <Navigate to="/home" replace /> },
      { path: "setup", Component: Setup },
      { path: "login", Component: Login },
      { path: "home", Component: Home },
    ],
  },
]);
```

- [ ] **Step 5: Confirm `apps/web/src/api.ts` already re-exports the shared type**

**No change needed — this is a verification step.** Phase 1 already landed this;
the file must read exactly as below, importing `InstallationState` from
`@harbor/shared` rather than declaring its own, so server and client cannot
drift. Confirm it does and move on; do not rewrite the file.

```ts
import type { InstallationState } from "@harbor/shared";

export type { InstallationState };

export async function fetchInstallationState(signal: AbortSignal): Promise<InstallationState> {
  const response = await fetch("/api/v1/installation/state", { signal });
  if (!response.ok) {
    throw new Error(`Installation state request failed with ${String(response.status)}`);
  }
  return (await response.json()) as InstallationState;
}
```

- [ ] **Step 6: Verify**

Run: `pnpm --filter @harbor/web build`
Expected: `tsc --noEmit` clean, Vite writes to `apps/server/public`.

Run: `pnpm lint` and `pnpm typecheck` from the root.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): setup wizard and login screens"
```

---

## Task 14: Playwright end-to-end tests

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/playwright.config.ts`, `e2e/tests/setup-and-login.spec.ts`, `e2e/.gitignore`
- Modify: `pnpm-workspace.yaml`, root `package.json`, `turbo.json`

**Interfaces:**
- Consumes: the running application
- Produces: `pnpm test:e2e`

- [ ] **Step 1: Add `e2e` to the workspace**

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "e2e"
```

- [ ] **Step 2: Create `e2e/package.json`**

```json
{
  "name": "@harbor/e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test:e2e": "playwright test",
    "lint": "eslint tests",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@playwright/test": "1.61.1",
    "@types/node": "24.13.3",
    "typescript": "6.0.3"
  }
}
```

- [ ] **Step 3: Create `e2e/tsconfig.json`**

Required, not optional. There is no root `tsconfig.json` — only
`tsconfig.base.json` — so without this file `tsc --noEmit` exits 1 with
`TS18003 "No inputs were found"`. Root `pnpm typecheck` runs across every
workspace package, so a missing config here fails the whole repo's typecheck,
which Task 15 Step 4 asserts is clean.

`moduleResolution: bundler` matches how Playwright loads the specs (extensionless
relative imports), unlike the `nodenext` packages.

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "moduleResolution": "bundler",
    "module": "esnext",
    "noEmit": true,
    "composite": false,
    "types": ["node"]
  },
  "include": ["tests", "playwright.config.ts"]
}
```

- [ ] **Step 4: Create `e2e/.gitignore`**

`.e2e-data/` is created by the `HARBOR_DATA_DIRECTORY` the config sets, and the
suite runs before `git add e2e` — without this entry the data directory gets
committed.

```
.e2e-data/
node_modules/
playwright-report/
test-results/
```

- [ ] **Step 5: Create `e2e/playwright.config.ts`**

`gracefulShutdown` is set because Harbor handles SIGTERM deliberately; letting Playwright hard-kill the process would leave containers behind.

```ts
import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "list" : "html",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../apps/server/dist/server.js",
    // /health/ready, not /health: boot.ts binds the listener BEFORE migrations
    // run, so /health answers 200 while the schema is still being created.
    // Waiting on it starts the tests mid-migration, /installation/state 503s,
    // and the app renders its error state. This matches the Dockerfile
    // HEALTHCHECK.
    url: `${BASE_URL}/api/v1/health/ready`,
    timeout: 120_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      NODE_ENV: "development",
      HARBOR_PORT: String(PORT),
      HARBOR_HOST: "127.0.0.1",
      HARBOR_BASE_URL: BASE_URL,
      HARBOR_SECRET: "e2e-secret-0123456789abcdef0123456789",
      HARBOR_DATA_DIRECTORY: "./.e2e-data",
      HARBOR_LOG_LEVEL: "warn",
      DATABASE_URL: process.env["E2E_DATABASE_URL"] ?? "",
    },
  },
});
```

- [ ] **Step 6: Create `e2e/tests/setup-and-login.spec.ts`**

`fullyParallel` is false and the tests run in order because they share one install: the first completes setup, and the rest depend on that state.

```ts
import { expect, test } from "@playwright/test";

const OWNER = {
  serverName: "E2E Harbor",
  username: "e2eowner",
  email: "e2e@example.com",
  password: "correct-horse-battery-staple",
};

test.describe.configure({ mode: "serial" });

test("a fresh install redirects to setup and creates the owner", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome to Harbor" })).toBeVisible();

  await page.getByLabel("Server name").fill(OWNER.serverName);
  await page.getByLabel("Username").fill(OWNER.username);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create owner account" }).click();

  // Setup issues a session, so the owner lands signed in rather than at /login.
  await expect(page).toHaveURL(/\/home$/);
});

test("a configured install no longer serves setup", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup$/);
});

test("an unauthenticated visitor is sent to login", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login$/);
});

test("wrong credentials are rejected with a generic message", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill("definitely-the-wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toContainText("Invalid credentials");
  await expect(page).toHaveURL(/\/login$/);
});

test("correct credentials sign the owner in and the session survives reload", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(OWNER.username);
  await page.getByLabel("Password").fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/home$/);

  await page.reload();
  await expect(page).toHaveURL(/\/home$/);

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "harbor_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
});
```

- [ ] **Step 7: Add a root script**

Add to the root `package.json` `scripts`:

```json
    "test:e2e": "turbo run test:e2e",
```

- [ ] **Step 8: Declare the task in `turbo.json`**

Required alongside the root script. Turbo 2 fails with "Could not find task
`test:e2e` in project" if the script exists but the task does not. Add to
`tasks`, alongside the existing `test` entry:

```json
    "test:e2e": {
      "dependsOn": ["^build"],
      "cache": false,
      "env": ["E2E_DATABASE_URL", "CI"]
    },
```

- [ ] **Step 9: Run it**

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm build
cd e2e && pnpm exec playwright install chromium && cd ..
E2E_DATABASE_URL=postgresql://harbor:harbor@localhost:5432/harbor pnpm test:e2e
```

Expected: 5 tests pass.

Note the e2e run completes setup against the dev database. To re-run from scratch, reset it:

```bash
docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d
```

Report the real output, then clean up.

- [ ] **Step 10: Commit**

```bash
git add e2e pnpm-workspace.yaml package.json turbo.json pnpm-lock.yaml
git commit -m "test(e2e): Playwright coverage for setup and login"
```

---

## Task 15: CI and documentation

**Files:**
- Modify: `.github/workflows/build-and-verify.yml`, `docs/development.md`, `README.md`

- [ ] **Step 1: Add an e2e job to `.github/workflows/build-and-verify.yml`**

Append after the existing `image` job. It provisions PostgreSQL as a service container, builds, installs only Chromium, and uploads the report on failure.

```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: verify
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_DB: harbor
          POSTGRES_USER: harbor
          POSTGRES_PASSWORD: harbor
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U harbor -d harbor"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Install Chromium
        run: pnpm --filter @harbor/e2e exec playwright install --with-deps chromium

      - name: Run end-to-end tests
        run: pnpm test:e2e
        env:
          E2E_DATABASE_URL: postgresql://harbor:harbor@localhost:5432/harbor

      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Update `docs/development.md`**

Add a section documenting the end-to-end tests:

```markdown
## End-to-end tests

Playwright drives a real browser against a built server.

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm build
pnpm --filter @harbor/e2e exec playwright install chromium
E2E_DATABASE_URL=postgresql://harbor:harbor@localhost:5432/harbor pnpm test:e2e
```

The suite completes setup against the target database, so re-running from a
clean state needs the volume reset:

```bash
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
```
```

Also add `pnpm test:e2e` to the commands table.

- [ ] **Step 3: Update the Status section in `README.md`**

Replace the Phase 1 status paragraph with:

```markdown
## Status

Phase 2a (identity core) — the server boots, migrates, completes first-run
setup, and authenticates users with server-side sessions. Roles are stored but
not yet enforced; invitations, user management, and profiles arrive in 2b and 2c.
```

- [ ] **Step 4: Verify everything, including the container**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all clean.

Then build and smoke the image. This is not optional this phase:
`@node-rs/argon2` is Harbor's **first dependency with platform-specific native
binaries**, and the Dockerfile installs production dependencies with
`pnpm deploy --prod --legacy`. Whether the correct `linux-*-gnu`/`musl` binary
lands in the runtime stage is not observable from `pnpm build` on the host — a
missing or wrong-libc binary shows up only as a boot-time
`Cannot find module '@node-rs/argon2-linux-...'`.

```bash
pnpm docker:build
pnpm docker:smoke
```

Expected: the build completes for the runtime stage, and the smoke test reports
the container healthy with `/api/v1/health` and `/api/v1/health/ready`
responding. Paste both outputs into your report.

If the image fails to resolve the native module, add the matching optional
dependency for the image's platform rather than switching to a pure-JS Argon2
implementation — password hashing performance is a security parameter here.

- [ ] **Step 5: Commit**

```bash
git add .github docs README.md
git commit -m "ci: run end-to-end tests, document the suite"
```

---

## Definition of Done

1. A fresh install serves `/setup`; completing the wizard creates the owner and lands them logged in.
2. Setup is atomic: concurrent attempts produce exactly one owner, and a failed attempt leaves the install retryable.
3. Repeat setup attempts return `409 SETUP_ALREADY_COMPLETE`.
4. Login and logout work; logout is idempotent and clears the cookie even when the session has already expired or been revoked; a session survives a page reload and a server restart. Restart survival is structural — sessions live in PostgreSQL, not process memory — and needs no separate mechanism.
5. Every route not on the public allowlist returns 401 without a valid session, including routes registered with no explicit guard. While Harbor is not ready, those routes still return `503 SERVICE_UNAVAILABLE` rather than a 500 from the guard's database lookup — Phase 1's contract is preserved.
6. `deleteSessionsForUser` exists and is tested (Task 2). No password-change endpoint ships in 2a — it arrives with user management in 2c — so the end-to-end invalidation flow is deliberately out of scope here.
7. Repeated failed logins return 429 with `Retry-After` and never permanently lock an account.
8. Unknown-user and wrong-password responses are indistinguishable apart from the request ID — **including on the throttled path**, where a backed-off account and a backed-off unknown identifier return the same status and the same `Retry-After`. The backoff is computed before the handler branches on whether the account exists, and failed attempts against unknown identifiers are tracked too.
9. Session cookies carry `HttpOnly` and `SameSite=Lax`, with `Secure` matching the base-URL protocol.
10. Cross-origin mutating requests are rejected.
11. Playwright covers first-time setup and owner login.
12. Lint, typecheck, unit, integration, and end-to-end tests pass, and `pnpm docker:build` + `pnpm docker:smoke` succeed — proving the new native `@node-rs/argon2` binary survives the image's `pnpm deploy --prod --legacy` step.
