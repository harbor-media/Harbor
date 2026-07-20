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

  it("finds a user case-insensitively regardless of stored or queried casing", async () => {
    const created = await createUser(db, base);
    expect((await findUserByIdentifier(db, "OWNER"))?.id).toBe(created.id);
    expect((await findUserByIdentifier(db, "  Owner  "))?.id).toBe(created.id);
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

  it("rejects a username containing '@' at the application level", async () => {
    await expect(
      createUser(db, { ...base, username: "has@sign" }),
    ).rejects.toThrow("username must not contain '@'");
  });

  it("rejects a username containing '@' at the database level (CHECK constraint)", async () => {
    let caught: unknown;
    try {
      await db.execute(
        sql`insert into users (username, email, password_hash, role)
            values ('raw@insert', 'raw-insert@example.com', 'hash', 'user')`,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const pgError = (caught as { cause?: unknown }).cause ?? caught;
    // eslint-disable-next-line no-console
    console.log("Postgres CHECK-violation error:", pgError);
    expect((pgError as { code?: string }).code).toBe("23514");
    expect((pgError as { constraint_name?: string }).constraint_name).toBe("users_username_no_at");
  });

  it("normalizes username and email on write and finds them with differently cased input", async () => {
    const created = await createUser(db, {
      ...base,
      username: "  OwnerTwo  ",
      email: "  Owner.Two@Example.COM  ",
    });

    expect(created.username).toBe("ownertwo");
    expect(created.email).toBe("owner.two@example.com");

    const found = await findUserByIdentifier(db, "OWNER.TWO@example.COM");
    expect(found?.id).toBe(created.id);
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
