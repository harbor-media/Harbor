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
