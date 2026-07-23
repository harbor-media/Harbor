import {
  getGenresFetchedAt,
  listCachedGenres,
  saveGenres,
  upsertTitles,
  type Db,
} from "@harbor/database";
import type {
  DiscoverResponse,
  DiscoverType,
  GenreListResponse,
  TitleCard,
} from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

/** Seven days. Genre taxonomies barely change; a week between refreshes is
 *  still far more current than the data ever moves. */
export const GENRE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export class DiscoverUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverUnsupportedError";
  }
}

export interface DiscoverDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
  tmdbBaseUrl?: string;
}

function isFresh(fetchedAt: Date | null, now: Date, ttl: number): boolean {
  if (fetchedAt === null) return false;
  return now.getTime() - fetchedAt.getTime() <= ttl;
}

async function loadDiscoverProvider(
  deps: DiscoverDeps,
): Promise<{ provider: MetadataProvider; language: string }> {
  const loaded = await loadProvider(deps.db, deps.harborSecret, deps.providerFactory, deps.tmdbBaseUrl);
  if (!loaded.provider.supportsDiscover) {
    throw new DiscoverUnsupportedError("The configured provider cannot browse by genre.");
  }
  return loaded;
}

export async function fetchGenres(deps: DiscoverDeps, type: DiscoverType): Promise<GenreListResponse> {
  const now = deps.now ?? (() => new Date());

  const fetchedAt = await getGenresFetchedAt(deps.db, type);
  if (isFresh(fetchedAt, now(), GENRE_TTL_MS)) {
    return { type, genres: await listCachedGenres(deps.db, type), cached: true };
  }

  const { provider, language } = await loadDiscoverProvider(deps);

  let genres;
  try {
    genres = await provider.getGenres(type, language, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (error) {
    // Same rule as the rest of the module: an outage degrades to stale data,
    // a rejected key does not.
    if (error instanceof MetadataProviderError && error.kind === "unavailable" && fetchedAt !== null) {
      return { type, genres: await listCachedGenres(deps.db, type), cached: true };
    }
    throw error;
  }

  await saveGenres(deps.db, type, genres, now());
  return { type, genres, cached: false };
}

export async function fetchDiscover(
  deps: DiscoverDeps,
  type: DiscoverType,
  genreId: string,
  page: number,
): Promise<DiscoverResponse> {
  const { provider, language } = await loadDiscoverProvider(deps);

  const result = await provider.discoverByGenre(
    type,
    genreId,
    page,
    language,
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
  );

  // Upsert so a card opens the detail page with no extra fetch. The ids come
  // back in the same order as the titles, which is the order to render.
  const ids = await upsertTitles(deps.db, result.titles);
  const titles: TitleCard[] = result.titles.map((t, i) => ({
    id: ids[i] as string,
    type: t.type,
    title: t.title,
    year: t.year,
    posterPath: t.posterPath,
  }));

  return { type, genreId, page: result.page, totalPages: result.totalPages, titles };
}
