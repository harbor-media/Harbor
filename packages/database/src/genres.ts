import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { genreCache } from "./schema.js";

export interface StoredGenre {
  id: string;
  name: string;
}

export async function getGenresFetchedAt(db: Db, type: string): Promise<Date | null> {
  const found = await db
    .select({ fetchedAt: genreCache.fetchedAt })
    .from(genreCache)
    .where(eq(genreCache.type, type))
    .limit(1);
  return found[0]?.fetchedAt ?? null;
}

export async function listCachedGenres(db: Db, type: string): Promise<StoredGenre[]> {
  const found = await db
    .select({ genres: genreCache.genres })
    .from(genreCache)
    .where(eq(genreCache.type, type))
    .limit(1);
  return found[0]?.genres ?? [];
}

/** Upserts the whole list for a type, replacing any prior list and stamping
 *  freshness. One statement, so the list and its timestamp are never torn. */
export async function saveGenres(
  db: Db,
  type: string,
  genres: StoredGenre[],
  now: Date,
): Promise<void> {
  await db
    .insert(genreCache)
    .values({ type, genres, fetchedAt: now })
    .onConflictDoUpdate({ target: genreCache.type, set: { genres, fetchedAt: now } });
}
