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
