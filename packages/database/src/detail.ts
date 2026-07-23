import { and, asc, eq, notInArray, sql } from "drizzle-orm";
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
  tagline: string | null;
  rating: number | null;
  logoPath: string | null;
  director: string | null;
  writers: string[];
  studios: string[];
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
  tagline: string | null;
  rating: number | null;
  logoPath: string | null;
  director: string | null;
  writers: string[];
  studios: string[];
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
    tagline: row.tagline,
    rating: row.rating,
    logoPath: row.logoPath,
    director: row.director,
    writers: row.writers,
    studios: row.studios,
    detailFetchedAt: row.detailFetchedAt,
    externalIds,
  };
}

/**
 * Writes a title's detail and its season list as one atomic unit.
 *
 * The two must not be separate statements. `detailFetchedAt` is what marks
 * the title fresh for the whole TTL, so committing it before the seasons
 * land means a failure in between (dropped connection, statement timeout,
 * SIGTERM mid-loop) leaves a title that is *fresh* but holds a truncated
 * season list. Every later request takes the cache-hit path and returns the
 * short list without ever retrying -- a 25-season show silently missing 19
 * seasons, unrecoverable for 24 hours without an operator UPDATE.
 *
 * Seasons the provider no longer lists are deleted, for the same reason
 * `replaceEpisodes` deletes rather than upserts: an upsert-only policy
 * leaves a phantom row no refetch removes. A phantom season is worse than a
 * phantom episode, because opening it asks the provider for a season that
 * does not exist -- a 404, which maps to `unavailable`, which the degraded
 * path then serves from cache forever. Episodes cascade from the season, so
 * the delete takes their rows with it.
 *
 * The prune is skipped when `seasonList` is empty. That covers movies, which
 * have no seasons at all, and refuses to read an empty provider payload as
 * "this series lost every season".
 */
export async function saveTitleDetail(
  db: Db,
  id: string,
  update: TitleDetailUpdate,
  seasonList: NormalizedSeason[],
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const item of seasonList) {
      await tx
        .insert(seasons)
        .values({
          titleId: id,
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

    if (seasonList.length > 0) {
      await tx.delete(seasons).where(
        and(
          eq(seasons.titleId, id),
          notInArray(
            seasons.seasonNumber,
            seasonList.map((item) => item.seasonNumber),
          ),
        ),
      );
    }

    await tx
      .update(titles)
      .set({
        originalTitle: update.originalTitle,
        year: update.year,
        overview: update.overview,
        posterPath: update.posterPath,
        backdropPath: update.backdropPath,
        runtime: update.runtime,
        genres: update.genres,
        tagline: update.tagline,
        rating: update.rating,
        logoPath: update.logoPath,
        director: update.director,
        writers: update.writers,
        studios: update.studios,
        detailFetchedAt: now,
        fetchedAt: now,
      })
      .where(eq(titles.id, id));
  });
}

export async function listSeasons(db: Db, titleId: string): Promise<NormalizedSeason[]> {
  const rows = await db
    .select()
    .from(seasons)
    .where(eq(seasons.titleId, titleId))
    // Ordered by number, so a tab strip reads 1, 2, 3 regardless of the order
    // the provider returned them or the order they were inserted -- except
    // that season 0, the specials, sorts LAST rather than first. Providers
    // number specials 0, so a naive ascending sort opens a show on its
    // specials instead of its first episode. Postgres orders false before
    // true, so the boolean expression puts every real season ahead of it.
    .orderBy(sql`(${seasons.seasonNumber} = 0)`, asc(seasons.seasonNumber));

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
    // FOR UPDATE, so two requests for the same season serialize here.
    // Without the lock, under READ COMMITTED the second transaction's DELETE
    // takes its snapshot before the first commits, so it cannot see the rows
    // the first is about to insert and deletes nothing -- then its own INSERT
    // collides with the unique index on (season_id, episode_number) and a
    // plain double-click on a season becomes a 500.
    const found = await tx
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(eq(seasons.titleId, titleId), eq(seasons.seasonNumber, seasonNumber)))
      .limit(1)
      .for("update");

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
