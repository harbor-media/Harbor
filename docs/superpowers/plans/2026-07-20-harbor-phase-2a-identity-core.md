# Harbor Phase 2a — Identity Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a freshly deployed Harbor from "not set up" to "the owner is logged in," with every route that is not explicitly public refusing unauthenticated requests.

**Architecture:** Two new tables (`users`, `sessions`) in the existing Drizzle schema. Argon2id password hashing. Opaque session tokens stored only as SHA-256 hashes. A single global `onRequest` hook authenticates every request against an exact-match public allowlist, so a route added without thought is protected by default. Owner creation and setup completion happen in one transaction, update-first, so a failure leaves the install retryable rather than bricked.

**Tech Stack:** Node 24, TypeScript 6.0.3, Fastify 5.10, `@node-rs/argon2` 2.0.2, `@fastify/cookie` 11.1.2, Drizzle 0.45.2 + postgres.js, Zod 4.4.3, React 19, Vitest 4.1.10, Testcontainers 12.0.4, Playwright 1.61.1.

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
| `apps/server/src/modules/auth/throttle.ts` | Backoff computation, per-IP store |
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
import { Algorithm, hash, verify } from "@node-rs/argon2";

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
  algorithm: Algorithm.Argon2id,
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
  - `backoffMs(failedCount: number): number`
  - `retryAfterSeconds(failedCount: number, lastFailedAt: Date | null, now?: Date): number` — 0 when not throttled
  - `class IpThrottle` with `record(ip: string): void`, `retryAfter(ip: string, now?: Date): number`, `reset(ip: string): void`
  - `FREE_ATTEMPTS`, `MAX_BACKOFF_MS`

- [ ] **Step 1: Write the failing test**

`apps/server/src/modules/auth/throttle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FREE_ATTEMPTS,
  IpThrottle,
  MAX_BACKOFF_MS,
  backoffMs,
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

describe("IpThrottle", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("throttles only after the free attempts", () => {
    const t = new IpThrottle();
    for (let i = 0; i < FREE_ATTEMPTS; i++) t.record("1.2.3.4", at);
    expect(t.retryAfter("1.2.3.4", at)).toBe(1);
  });

  it("tracks addresses independently", () => {
    const t = new IpThrottle();
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("1.1.1.1", at);
    expect(t.retryAfter("1.1.1.1", at)).toBeGreaterThan(0);
    expect(t.retryAfter("2.2.2.2", at)).toBe(0);
  });

  it("resets on success", () => {
    const t = new IpThrottle();
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("9.9.9.9", at);
    t.reset("9.9.9.9");
    expect(t.retryAfter("9.9.9.9", at)).toBe(0);
  });

  it("evicts the oldest entries past its cap so it cannot grow unbounded", () => {
    const t = new IpThrottle(3);
    for (const ip of ["a", "b", "c", "d"]) {
      for (let i = 0; i < FREE_ATTEMPTS + 1; i++) t.record(ip, at);
    }
    // "a" was evicted when "d" arrived, so it is no longer throttled.
    expect(t.retryAfter("a", at)).toBe(0);
    expect(t.retryAfter("d", at)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harbor/server test throttle`
Expected: FAIL — cannot resolve `./throttle.js`.

- [ ] **Step 3: Create `apps/server/src/modules/auth/throttle.ts`**

```ts
export const FREE_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
const DEFAULT_IP_CAPACITY = 10_000;

/** Doubling backoff after a few free attempts, capped so nothing locks out. */
export function backoffMs(failedCount: number): number {
  if (failedCount < FREE_ATTEMPTS) return 0;
  const scaled = BASE_BACKOFF_MS * 2 ** (failedCount - FREE_ATTEMPTS);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

/** Seconds the caller must wait, or 0 when not throttled. */
export function retryAfterSeconds(
  failedCount: number,
  lastFailedAt: Date | null,
  now: Date = new Date(),
): number {
  if (lastFailedAt === null) return 0;
  const window = backoffMs(failedCount);
  if (window === 0) return 0;
  const remaining = lastFailedAt.getTime() + window - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

interface IpEntry {
  count: number;
  lastFailedAt: Date;
}

/**
 * Per-IP failure tracking, deliberately in memory rather than the database:
 * a write per failed guess would itself be a denial-of-service vector. State
 * is lost on restart, which is acceptable because per-account throttling —
 * which does persist — is what defends a targeted attack.
 *
 * Capacity-bounded with oldest-first eviction so an attacker rotating source
 * addresses cannot exhaust memory.
 */
export class IpThrottle {
  readonly #entries = new Map<string, IpEntry>();
  readonly #capacity: number;

  constructor(capacity: number = DEFAULT_IP_CAPACITY) {
    this.#capacity = capacity;
  }

  record(ip: string, now: Date = new Date()): void {
    const existing = this.#entries.get(ip);
    if (existing) {
      existing.count += 1;
      existing.lastFailedAt = now;
      // Re-insert to mark as most recently used.
      this.#entries.delete(ip);
      this.#entries.set(ip, existing);
      return;
    }

    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(ip, { count: 1, lastFailedAt: now });
  }

  retryAfter(ip: string, now: Date = new Date()): number {
    const entry = this.#entries.get(ip);
    if (!entry) return 0;
    return retryAfterSeconds(entry.count, entry.lastFailedAt, now);
  }

  reset(ip: string): void {
    this.#entries.delete(ip);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @harbor/server test throttle`
Expected: PASS, 12 tests.

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
import type { Db } from "@harbor/database";
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
Expected: PASS — 6 new guard tests plus all pre-existing tests.

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

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test-helpers.js";

// testEnv sets HARBOR_BASE_URL to http://localhost:3000
async function build() {
  const app = await buildTestApp({ ready: true });
  app.post("/api/v1/mutating-probe", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("origin check", () => {
  it("allows a same-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("rejects a cross-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows a request with no Origin (non-browser client)", async () => {
    // A browser always sends Origin on a cross-site POST, so its absence means
    // a non-browser caller, which carries no ambient cookies and so no CSRF risk.
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/api/v1/mutating-probe" });
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });

  it("falls back to Referer when Origin is absent", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
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

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/database test`
Expected: PASS — 4 setup tests plus everything prior.

- [ ] **Step 6: Commit**

```bash
git add packages/database
git commit -m "feat(database): atomic owner creation and setup completion"
```

---

## Task 11: Setup and auth routes

**Files:**
- Create: `apps/server/src/modules/setup/routes.ts`, `apps/server/src/modules/auth/routes.ts`, `apps/server/src/modules/auth/routes.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-10
- Produces: `setupRoutes`, `authRoutes` Fastify plugins

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

- [ ] **Step 2: Create `apps/server/src/modules/auth/routes.ts`**

```ts
import {
  createSession,
  deleteSession,
  findUserByIdentifier,
  recordFailedLogin,
  resetFailedLogins,
} from "@harbor/database";
import type { AuthenticatedUser } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { clearSessionCookie, setSessionCookie } from "./cookies.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";
import { IpThrottle, retryAfterSeconds } from "./throttle.js";
import { generateSessionToken, hashSessionToken, sessionExpiry } from "./tokens.js";

const LoginSchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});

/** One generic message for both unknown-user and wrong-password. */
const INVALID_CREDENTIALS = "Invalid credentials.";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const ipThrottle = new IpThrottle();

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

      if (!user) {
        // Constant work so response timing does not reveal account existence.
        await verifyAgainstDummy();
        ipThrottle.record(request.ip);
        throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);
      }

      const accountWait = retryAfterSeconds(user.failedLoginCount, user.lastFailedLoginAt);
      if (accountWait > 0) {
        void reply.header("Retry-After", String(accountWait));
        throw new HarborError("RATE_LIMITED", "Too many attempts. Try again shortly.", 429);
      }

      if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
        await recordFailedLogin(fastify.db, user.id);
        ipThrottle.record(request.ip);
        fastify.log.warn({ userId: user.id }, "failed login");
        throw new HarborError("UNAUTHENTICATED", INVALID_CREDENTIALS, 401);
      }

      await resetFailedLogins(fastify.db, user.id);
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

  fastify.post("/auth/logout", async (request, reply) => {
    if (request.session) await deleteSession(fastify.db, request.session.id);
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

Note `hashPassword` is imported above only for the setup route's sibling module; if your editor flags it as unused in this file, remove that import rather than leaving a re-export.

- [ ] **Step 3: Register both in `apps/server/src/app.ts`**

Add imports and register inside the existing `{ prefix: API_PREFIX }` scope, after `installationRoutes`:

```ts
import { authRoutes } from "./modules/auth/routes.js";
import { setupRoutes } from "./modules/setup/routes.js";
...
      await api.register(setupRoutes);
      await api.register(authRoutes);
```

- [ ] **Step 4: Write the route tests**

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

beforeEach(async () => {
  vi.clearAllMocks();
  storedHash ??= await hashPassword(PASSWORD);
  vi.mocked(db.createSession).mockResolvedValue({} as never);
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
  it("is itself guarded — logging out without a session is rejected", async () => {
    // Logout is deliberately NOT on the public allowlist, so the guard rejects
    // before the handler runs. Logging out with no session is meaningless.
    vi.mocked(db.findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(401);
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

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @harbor/server test`
Expected: PASS — all new route tests plus everything prior.

- [ ] **Step 6: Verify against a real database**

Start Postgres, build, boot the server (see `docs/development.md` for the exported variables), then:

```bash
curl -si -X POST localhost:3000/api/v1/setup -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"language":"en","serverName":"Test","username":"owner","email":"o@example.com","password":"correct-horse-battery"}'
```

Confirm: `201`, a `set-cookie` carrying `harbor_session` with `HttpOnly` and `SameSite=Lax`, and a body containing the user without any hash.

Then confirm the session works and repeat-setup is refused:

```bash
curl -s localhost:3000/api/v1/auth/me -b "harbor_session=<token from the cookie>"
curl -si -X POST localhost:3000/api/v1/setup -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' -d '{"language":"en","serverName":"x","username":"a","email":"a@b.co","password":"correct-horse-battery"}' | head -1
```

Expected: the first returns the owner; the second returns `409`.

Report the real output. Clean up the container afterwards.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(auth): setup, login, logout and me routes"
```

---

## Task 12: Web — setup wizard and login

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

- [ ] **Step 5: Import the shared types in `apps/web/src/api.ts`**

Replace its locally-declared `InstallationState` with a re-export so server and client cannot drift:

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

## Task 13: Playwright end-to-end tests

**Files:**
- Create: `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/tests/setup-and-login.spec.ts`, `e2e/.gitignore`
- Modify: `pnpm-workspace.yaml`, root `package.json`

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

- [ ] **Step 3: Create `e2e/.gitignore`**

```
playwright-report/
test-results/
```

- [ ] **Step 4: Create `e2e/playwright.config.ts`**

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
    url: `${BASE_URL}/api/v1/health`,
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

- [ ] **Step 5: Create `e2e/tests/setup-and-login.spec.ts`**

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

- [ ] **Step 6: Add a root script**

Add to the root `package.json` `scripts`:

```json
    "test:e2e": "turbo run test:e2e",
```

- [ ] **Step 7: Run it**

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

- [ ] **Step 8: Commit**

```bash
git add e2e pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "test(e2e): Playwright coverage for setup and login"
```

---

## Task 14: CI and documentation

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

- [ ] **Step 4: Verify everything**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all clean.

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
4. Login and logout work; a session survives a page reload and a server restart. Restart survival is structural — sessions live in PostgreSQL, not process memory — and needs no separate mechanism.
5. Every route not on the public allowlist returns 401 without a valid session, including routes registered with no explicit guard.
6. `deleteSessionsForUser` exists and is tested (Task 2). No password-change endpoint ships in 2a — it arrives with user management in 2c — so the end-to-end invalidation flow is deliberately out of scope here.
7. Repeated failed logins return 429 with `Retry-After` and never permanently lock an account.
8. Unknown-user and wrong-password responses are indistinguishable apart from the request ID.
9. Session cookies carry `HttpOnly` and `SameSite=Lax`, with `Secure` matching the base-URL protocol.
10. Cross-origin mutating requests are rejected.
11. Playwright covers first-time setup and owner login.
12. Lint, typecheck, unit, integration, and end-to-end tests pass.
