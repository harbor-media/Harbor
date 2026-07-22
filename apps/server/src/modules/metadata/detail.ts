import {
  getSeasonEpisodes,
  getTitleDetail,
  listSeasons,
  replaceEpisodes,
  saveTitleDetail,
  upsertSeasons,
  type Db,
  type NormalizedSeason,
  type StoredTitleDetail,
} from "@harbor/database";
import type { SeasonResponse, SeasonSummary, TitleDetailResponse } from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

/**
 * A finished film's runtime and overview do not change hourly, so detail is
 * held for a day. The cost of the long window is that a currently-airing
 * series' episode list can lag by up to that long.
 */
export const DETAIL_TTL_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export class TitleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleNotFoundError";
  }
}

export interface DetailDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
  tmdbBaseUrl?: string;
}

function toSummary(season: NormalizedSeason): SeasonSummary {
  return {
    seasonNumber: season.seasonNumber,
    name: season.name,
    episodeCount: season.episodeCount,
    posterPath: season.posterPath,
    airDate: season.airDate,
  };
}

function toResponse(
  title: StoredTitleDetail,
  seasons: NormalizedSeason[],
  cached: boolean,
): TitleDetailResponse {
  return {
    id: title.id,
    type: title.type,
    title: title.title,
    originalTitle: title.originalTitle,
    year: title.year,
    overview: title.overview,
    posterPath: title.posterPath,
    backdropPath: title.backdropPath,
    runtime: title.runtime,
    genres: title.genres,
    seasons: seasons.map(toSummary),
    cached,
  };
}

function isFresh(fetchedAt: Date | null, now: Date): boolean {
  if (fetchedAt === null) return false;
  return now.getTime() - fetchedAt.getTime() <= DETAIL_TTL_MS;
}

/** The provider identifier for a title, or null when it has none. */
function tmdbIdOf(title: StoredTitleDetail): string | null {
  return title.externalIds.find((e) => e.source === "tmdb")?.externalId ?? null;
}

export async function fetchTitleDetail(
  deps: DetailDeps,
  titleId: string,
): Promise<TitleDetailResponse> {
  const now = deps.now ?? (() => new Date());
  const title = await getTitleDetail(deps.db, titleId);
  if (!title) throw new TitleNotFoundError("No such title.");

  if (isFresh(title.detailFetchedAt, now())) {
    return toResponse(title, await listSeasons(deps.db, titleId), true);
  }

  const externalId = tmdbIdOf(title);
  if (externalId === null) {
    throw new TitleNotFoundError("Title has no provider identifier.");
  }

  const { provider, language } = await loadProvider(
    deps.db,
    deps.harborSecret,
    deps.providerFactory,
    deps.tmdbBaseUrl,
  );

  let detail;
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    detail =
      title.type === "movie"
        ? await provider.getMovie(externalId, language, signal)
        : await provider.getSeries(externalId, language, signal);
  } catch (error) {
    // An outage should degrade to stale data rather than an error page --
    // expiry is a freshness preference, and Harbor already holds something
    // worth showing. A rejected key is deliberately NOT covered: serving
    // stale data over a broken credential hides a problem that only an
    // administrator can fix, and search would appear to work while silently
    // going stale forever.
    if (
      error instanceof MetadataProviderError &&
      error.kind === "unavailable" &&
      title.detailFetchedAt !== null
    ) {
      return toResponse(title, await listSeasons(deps.db, titleId), true);
    }
    throw error;
  }

  await saveTitleDetail(
    deps.db,
    titleId,
    {
      originalTitle: detail.originalTitle,
      year: detail.year,
      overview: detail.overview,
      posterPath: detail.posterPath,
      backdropPath: detail.backdropPath,
      runtime: detail.runtime,
      genres: detail.genres,
    },
    now(),
  );

  if (detail.seasons.length > 0) {
    await upsertSeasons(deps.db, titleId, detail.seasons);
  }

  const stored = await getTitleDetail(deps.db, titleId);
  if (!stored) throw new TitleNotFoundError("No such title.");

  return toResponse(stored, await listSeasons(deps.db, titleId), false);
}

export async function fetchSeasonDetail(
  deps: DetailDeps,
  titleId: string,
  seasonNumber: number,
): Promise<SeasonResponse> {
  const now = deps.now ?? (() => new Date());
  const title = await getTitleDetail(deps.db, titleId);
  if (!title) throw new TitleNotFoundError("No such title.");

  // The season list is written by fetchTitleDetail from the title payload, so
  // a number absent from it is a season the show does not have. Asking the
  // provider anyway would be a wasted round trip for something that cannot
  // exist.
  const existing = await getSeasonEpisodes(deps.db, titleId, seasonNumber);
  if (!existing) throw new TitleNotFoundError("No such season.");

  if (isFresh(existing.fetchedAt, now())) {
    return {
      seasonNumber: existing.season.seasonNumber,
      name: existing.season.name,
      overview: existing.season.overview,
      episodes: existing.episodes,
      cached: true,
    };
  }

  const externalId = tmdbIdOf(title);
  if (externalId === null) {
    throw new TitleNotFoundError("Title has no provider identifier.");
  }

  const { provider, language } = await loadProvider(
    deps.db,
    deps.harborSecret,
    deps.providerFactory,
    deps.tmdbBaseUrl,
  );

  let episodes;
  try {
    episodes = await provider.getSeason(
      externalId,
      seasonNumber,
      language,
      AbortSignal.timeout(FETCH_TIMEOUT_MS),
    );
  } catch (error) {
    if (
      error instanceof MetadataProviderError &&
      error.kind === "unavailable" &&
      existing.fetchedAt !== null
    ) {
      return {
        seasonNumber: existing.season.seasonNumber,
        name: existing.season.name,
        overview: existing.season.overview,
        episodes: existing.episodes,
        cached: true,
      };
    }
    throw error;
  }

  await replaceEpisodes(deps.db, titleId, seasonNumber, episodes, now());

  const stored = await getSeasonEpisodes(deps.db, titleId, seasonNumber);
  if (!stored) throw new TitleNotFoundError("No such season.");

  return {
    seasonNumber: stored.season.seasonNumber,
    name: stored.season.name,
    overview: stored.season.overview,
    episodes: stored.episodes,
    cached: false,
  };
}
