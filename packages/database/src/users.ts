import { eq, sql } from "drizzle-orm";
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
  const username = normalize(input.username);
  if (username.includes("@")) {
    throw new Error("username must not contain '@'");
  }

  const rows = await db
    .insert(users)
    .values({
      username,
      email: input.email === null ? null : normalize(input.email),
      passwordHash: input.passwordHash,
      role: input.role,
    })
    .returning();

  const created = rows[0];
  if (!created) throw new Error("user insert returned no row");
  return created;
}

/**
 * Usernames and emails are uniquely constrained independently, so a
 * username could otherwise collide with a different user's email address.
 * Usernames are forbidden from containing "@" (see createUser), which makes
 * the two namespaces structurally disjoint. Dispatching on the presence of
 * "@" here — rather than matching either column with `or(...)` — keeps
 * lookup unambiguous by construction and lets Postgres use a single index.
 */
export async function findUserByIdentifier(db: Db, identifier: string): Promise<User | null> {
  const value = normalize(identifier);
  const rows = await db
    .select()
    .from(users)
    .where(value.includes("@") ? eq(users.email, value) : eq(users.username, value))
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
