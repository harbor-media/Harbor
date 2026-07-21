import { and, eq, inArray, sql } from "drizzle-orm";
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
      // Two concurrent upserts of the same (source, external_id) can both run
      // the SELECT below before either INSERT commits -- READ COMMITTED does
      // not protect against that -- and both would then insert a `titles`
      // row, with only one surviving the title_external_ids unique index
      // (the other silently swallowed by onConflictDoNothing). That leaves an
      // orphaned title row with no external-id link. A transaction-scoped
      // advisory lock serializes upserts of the same natural key while
      // leaving different titles fully parallel; PostgreSQL releases it
      // automatically at commit or rollback, so it cannot leak. Same idiom as
      // the migration lock in migrate.ts, scoped to the transaction instead
      // of the session since this connection is pooled.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${primary.source} || ':' || ${primary.externalId}))`,
      );

      // The natural key is (source, external_id) -- matching by external_id
      // alone would conflate ids from different providers.
      const existing = await tx
        .select({ titleId: titleExternalIds.titleId })
        .from(titleExternalIds)
        .where(
          and(
            eq(titleExternalIds.source, primary.source),
            eq(titleExternalIds.externalId, primary.externalId),
          ),
        )
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
