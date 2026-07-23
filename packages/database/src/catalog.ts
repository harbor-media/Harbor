import { asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { catalogEntries, catalogRows, titles } from "./schema.js";
import { upsertTitles, type NormalizedTitle } from "./titles.js";

/** Exactly the fields a poster card renders. */
export interface StoredCatalogTitle {
  id: string;
  type: "movie" | "series";
  title: string;
  year: number | null;
  posterPath: string | null;
}

export async function getCatalogFetchedAt(db: Db, kind: string): Promise<Date | null> {
  const found = await db
    .select({ fetchedAt: catalogRows.fetchedAt })
    .from(catalogRows)
    .where(eq(catalogRows.kind, kind))
    .limit(1);
  return found[0]?.fetchedAt ?? null;
}

export async function listCatalogTitles(db: Db, kind: string): Promise<StoredCatalogTitle[]> {
  const rows = await db
    .select({
      id: titles.id,
      type: titles.type,
      title: titles.title,
      year: titles.year,
      posterPath: titles.posterPath,
    })
    .from(catalogEntries)
    .innerJoin(titles, eq(titles.id, catalogEntries.titleId))
    .where(eq(catalogEntries.kind, kind))
    // The ranking IS the row. Without this the order is whatever PostgreSQL
    // finds convenient.
    .orderBy(asc(catalogEntries.position));

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    year: r.year,
    posterPath: r.posterPath,
  }));
}

/**
 * Replaces a row's membership and stamps its freshness together.
 *
 * The stamp and the entries are one transaction so a partial write can never
 * be cached as complete -- the failure the 3c-2a review found in
 * `detailFetchedAt`, where the freshness stamp committed ahead of the season
 * list and pinned a truncated row for the whole TTL.
 *
 * `upsertTitles` runs first and outside that transaction on purpose. Titles
 * are global and shared with search, the upsert is idempotent and carries its
 * own advisory lock, and a title existing without a catalog entry is the
 * ordinary state of every title search has ever returned.
 *
 * Delete-then-insert, not upsert, for the reason `replaceEpisodes` documents:
 * a title that has dropped out of Trending must actually leave.
 */
export async function saveCatalogRow(
  db: Db,
  kind: string,
  items: NormalizedTitle[],
  now: Date,
): Promise<void> {
  const titleIds = await upsertTitles(db, items);

  // De-duplicated, first occurrence wins. A provider can return the same title
  // twice in one page -- and two items with the same external id resolve to a
  // single title row, so upsertTitles hands back that id twice. Written as-is
  // that becomes two entries pointing at one title: the row renders the poster
  // twice and, because position is the only thing distinguishing them, React
  // sees two children with the same key. Keeping the first occurrence also
  // preserves the provider's ranking, since earlier means higher-ranked.
  const seen = new Set<string>();
  const orderedIds = titleIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));

  await db.transaction(async (tx) => {
    await tx
      .insert(catalogRows)
      .values({ kind, fetchedAt: now })
      .onConflictDoUpdate({ target: catalogRows.kind, set: { fetchedAt: now } });

    await tx.delete(catalogEntries).where(eq(catalogEntries.kind, kind));

    if (orderedIds.length > 0) {
      await tx.insert(catalogEntries).values(
        orderedIds.map((titleId, index) => ({ kind, position: index, titleId })),
      );
    }
  });
}
