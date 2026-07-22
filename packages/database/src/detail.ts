import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { episodes, seasons, titleExternalIds, titles } from "./schema.js";
import type { StoredTitle, TitleExternalId } from "./titles.js";

export interface NormalizedSeason {
  seasonNumber: number;
  name: string | null;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number | null;
  airDate: string | null;
}

export interface NormalizedEpisode {
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
  runtime: number | null;
  airDate: string | null;
}

export interface StoredTitleDetail extends StoredTitle {
  runtime: number | null;
  genres: string[];
  detailFetchedAt: Date | null;
}

export interface TitleDetailUpdate {
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  genres: string[];
}

export async function getTitleDetail(db: Db, id: string): Promise<StoredTitleDetail | null> {
  const rows = await db.select().from(titles).where(eq(titles.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const externals = await db
    .select()
    .from(titleExternalIds)
    .where(eq(titleExternalIds.titleId, id));

  const externalIds: TitleExternalId[] = externals.map((e) => ({
    source: e.source,
    externalId: e.externalId,
  }));

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    originalTitle: row.originalTitle,
    year: row.year,
    overview: row.overview,
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    runtime: row.runtime,
    genres: row.genres,
    detailFetchedAt: row.detailFetchedAt,
    externalIds,
  };
}

export async function saveTitleDetail(
  db: Db,
  id: string,
  update: TitleDetailUpdate,
  now: Date,
): Promise<void> {
  await db
    .update(titles)
    .set({
      originalTitle: update.originalTitle,
      year: update.year,
      overview: update.overview,
      posterPath: update.posterPath,
      backdropPath: update.backdropPath,
      runtime: update.runtime,
      genres: update.genres,
      detailFetchedAt: now,
      fetchedAt: now,
    })
    .where(eq(titles.id, id));
}

export async function upsertSeasons(
  db: Db,
  titleId: string,
  items: NormalizedSeason[],
): Promise<void> {
  if (items.length === 0) return;

  for (const item of items) {
    await db
      .insert(seasons)
      .values({
        titleId,
        seasonNumber: item.seasonNumber,
        name: item.name,
        overview: item.overview,
        posterPath: item.posterPath,
        episodeCount: item.episodeCount,
        airDate: item.airDate,
      })
      .onConflictDoUpdate({
        target: [seasons.titleId, seasons.seasonNumber],
        set: {
          name: item.name,
          overview: item.overview,
          posterPath: item.posterPath,
          episodeCount: item.episodeCount,
          airDate: item.airDate,
        },
      });
  }
}

export async function listSeasons(db: Db, titleId: string): Promise<NormalizedSeason[]> {
  const rows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.titleId, titleId))
    // Ordered by number: a tab strip must read 1, 2, 3 regardless of the
    // order the provider returned them or the order they were inserted.
    .orderBy(asc(seasons.seasonNumber));

  return rows.map((r) => ({
    seasonNumber: r.seasonNumber,
    name: r.name,
    overview: r.overview,
    posterPath: r.posterPath,
    episodeCount: r.episodeCount,
    airDate: r.airDate,
  }));
}

/**
 * Replaces a season's episodes wholesale. Returns false when the season row
 * does not exist.
 *
 * Delete-then-insert rather than upsert: a provider that drops an episode
 * should drop it here too. An upsert would leave a phantom row that no
 * refetch ever removes, and the episode list would slowly diverge from the
 * provider's without anything appearing to fail.
 */
export async function replaceEpisodes(
  db: Db,
  titleId: string,
  seasonNumber: number,
  items: NormalizedEpisode[],
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.titleId, titleId), eq(seasons.seasonNumber, seasonNumber)))
      .limit(1);

    const season = found[0];
    if (!season) return false;

    await tx.delete(episodes).where(eq(episodes.seasonId, season.id));

    if (items.length > 0) {
      await tx.insert(episodes).values(
        items.map((item) => ({
          seasonId: season.id,
          episodeNumber: item.episodeNumber,
          name: item.name,
          overview: item.overview,
          stillPath: item.stillPath,
          runtime: item.runtime,
          airDate: item.airDate,
        })),
      );
    }

    await tx.update(seasons).set({ fetchedAt: now }).where(eq(seasons.id, season.id));
    return true;
  });
}

export async function getSeasonEpisodes(
  db: Db,
  titleId: string,
  seasonNumber: number,
): Promise<{
  season: NormalizedSeason;
  episodes: NormalizedEpisode[];
  fetchedAt: Date | null;
} | null> {
  const found = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.titleId, titleId), eq(seasons.seasonNumber, seasonNumber)))
    .limit(1);

  const season = found[0];
  if (!season) return null;

  const rows = await db
    .select()
    .from(episodes)
    .where(eq(episodes.seasonId, season.id))
    .orderBy(asc(episodes.episodeNumber));

  return {
    season: {
      seasonNumber: season.seasonNumber,
      name: season.name,
      overview: season.overview,
      posterPath: season.posterPath,
      episodeCount: season.episodeCount,
      airDate: season.airDate,
    },
    episodes: rows.map((r) => ({
      episodeNumber: r.episodeNumber,
      name: r.name,
      overview: r.overview,
      stillPath: r.stillPath,
      runtime: r.runtime,
      airDate: r.airDate,
    })),
    fetchedAt: season.fetchedAt,
  };
}
