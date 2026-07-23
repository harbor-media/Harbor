import type { NormalizedEpisode, NormalizedTitle } from "@harbor/database";
import type { CatalogKind, DiscoverType, Genre } from "@harbor/shared";
import { z } from "zod";
import {
  MetadataProviderError,
  type DiscoverResult,
  type MetadataProvider,
  type MetadataSearchQuery,
  type ProviderTitleDetail,
} from "./types.js";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

/**
 * TMDB is an external boundary, so nothing crosses it untyped at runtime.
 *
 * Casting the payload instead let a malformed response reach code that
 * assumed its shape: a `genres` that was not an array threw a raw TypeError
 * that escaped MetadataProviderError and surfaced as a bare 500, and an
 * episode missing `episode_number` carried `undefined` all the way into a
 * NOT NULL column, turning a provider quirk into a database error on an
 * ordinary read.
 *
 * The schemas are permissive about unknown keys -- Zod strips them, so TMDB
 * adding a field never breaks Harbor -- and strict about the handful of
 * fields that are actually load-bearing.
 */
const searchItemSchema = z.object({
  id: z.number(),
  media_type: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  original_title: z.string().optional(),
  original_name: z.string().optional(),
  release_date: z.string().optional(),
  first_air_date: z.string().optional(),
  overview: z.string().optional(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
});

type TmdbSearchItem = z.infer<typeof searchItemSchema>;

const searchResponseSchema = z.object({
  // Per-item, not array-wide: a single unusable result must not discard the
  // rest of the page. Multi-search already drops people for the same reason.
  results: z.array(z.unknown()).optional(),
});

const genreSchema = z.object({ name: z.string() });

const seasonSummarySchema = z.object({
  season_number: z.number(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  episode_count: z.number().nullish(),
  air_date: z.string().nullish(),
});

const detailSchema = z.object({
  original_title: z.string().nullish(),
  original_name: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  runtime: z.number().nullish(),
  episode_run_time: z.array(z.number()).nullish(),
  genres: z.array(genreSchema).nullish(),
  seasons: z.array(seasonSummarySchema).nullish(),
});

const episodeSchema = z.object({
  episode_number: z.number(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  still_path: z.string().nullish(),
  runtime: z.number().nullish(),
  air_date: z.string().nullish(),
});

const seasonResponseSchema = z.object({
  episodes: z.array(episodeSchema).nullish(),
});

/**
 * A payload that does not match is treated as an outage, not a crash.
 *
 * "unavailable" is the honest classification: Harbor cannot use what the
 * provider sent, which is the same practical situation as not reaching it,
 * and it routes into the existing degraded path so a cached title still
 * renders. The validation issue is deliberately not included in the message
 * -- it can quote payload fragments, and this text reaches the client.
 */
function parseOrUnavailable<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MetadataProviderError(
      "unavailable",
      "The metadata provider returned an unexpected response.",
    );
  }
  return result.data;
}

function yearOf(value: string | undefined): number | null {
  if (!value) return null;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function normalize(item: TmdbSearchItem): NormalizedTitle | null {
  // TMDB's multi-search returns people alongside titles. People are not
  // watchable and must not enter the catalog.
  if (item.media_type !== "movie" && item.media_type !== "tv") return null;

  const isMovie = item.media_type === "movie";
  const title = isMovie ? item.title : item.name;
  if (!title) return null;

  return {
    type: isMovie ? "movie" : "series",
    title,
    originalTitle: (isMovie ? item.original_title : item.original_name) ?? null,
    year: yearOf(isMovie ? item.release_date : item.first_air_date),
    overview: item.overview ?? null,
    posterPath: item.poster_path ?? null,
    backdropPath: item.backdrop_path ?? null,
    externalIds: [{ source: "tmdb", externalId: String(item.id) }],
  };
}

/**
 * Providers use "" for an unknown value as often as null. Storing the empty
 * string would make an absent overview render as a blank block instead of
 * being skipped, and an absent air date sort as though it were a real value.
 */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function toDetail(
  payload: z.infer<typeof detailSchema>,
  isMovie: boolean,
): ProviderTitleDetail {
  const runTimes = payload.episode_run_time ?? [];
  const seasonList = payload.seasons ?? [];

  return {
    originalTitle: textOrNull(
      isMovie ? payload.original_title : payload.original_name,
    ),
    year: yearOf(
      isMovie
        ? (payload.release_date ?? undefined)
        : (payload.first_air_date ?? undefined),
    ),
    overview: textOrNull(payload.overview),
    posterPath: textOrNull(payload.poster_path),
    backdropPath: textOrNull(payload.backdrop_path),
    // A movie carries a single runtime; a series carries a list of typical
    // episode lengths, whose first entry is the representative one.
    runtime: isMovie ? (payload.runtime ?? null) : (runTimes[0] ?? null),
    genres: (payload.genres ?? []).map((g) => g.name),
    seasons: isMovie
      ? []
      : seasonList.map((sn) => ({
          seasonNumber: sn.season_number,
          name: textOrNull(sn.name),
          overview: textOrNull(sn.overview),
          posterPath: textOrNull(sn.poster_path),
          episodeCount: sn.episode_count ?? null,
          airDate: textOrNull(sn.air_date),
        })),
  };
}

/**
 * `/movie/*` and `/tv/*` return no `media_type`, but multi-search does and
 * `normalize()` requires it. The adapter supplies it for the single-type
 * endpoints and trusts it on `/trending/all/week`, which genuinely mixes
 * movies, series and people.
 */
const CATALOG_ENDPOINTS: Record<CatalogKind, { path: string; mediaType?: "movie" | "tv" }> = {
  trending: { path: "/trending/all/week" },
  "popular-movies": { path: "/movie/popular", mediaType: "movie" },
  "popular-series": { path: "/tv/popular", mediaType: "tv" },
  "new-releases": { path: "/movie/now_playing", mediaType: "movie" },
};

const CATALOG_KINDS_SUPPORTED = Object.keys(CATALOG_ENDPOINTS) as CatalogKind[];

// series -> tv is the only mapping TMDB needs; movie is identical.
const DISCOVER_TMDB_TYPE: Record<DiscoverType, "movie" | "tv"> = {
  movie: "movie",
  series: "tv",
};

// The genre list is parsed permissively at the outer level, then each entry
// individually -- so one malformed entry is dropped rather than failing the
// whole list, exactly as search results are handled.
const genreListSchema = z.object({ genres: z.array(z.unknown()).nullish() });
const genreItemSchema = z.object({ id: z.number(), name: z.string() });

const discoverResponseSchema = z.object({
  page: z.number(),
  total_pages: z.number(),
  results: z.array(z.unknown()).nullish(),
});

export interface TmdbProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createTmdbProvider(
  apiKey: string,
  options: TmdbProviderOptions = {},
): MetadataProvider {
  const baseUrl = options.baseUrl ?? TMDB_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  // The credential travels in the Authorization header, never the query
  // string: query strings land in proxy logs, browser history, and Referer
  // headers.
  async function call(
    path: string,
    params: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}?${params.toString()}`, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
        signal,
      });
    } catch {
      // The upstream error is deliberately swallowed rather than chained: it
      // can contain the request URL and header material.
      throw new MetadataProviderError(
        "unavailable",
        "The metadata provider could not be reached.",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new MetadataProviderError(
        "unauthorized",
        "The metadata provider rejected the API key.",
      );
    }
    if (!response.ok) {
      throw new MetadataProviderError(
        "unavailable",
        `The metadata provider returned status ${String(response.status)}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new MetadataProviderError(
        "unavailable",
        "The metadata provider returned invalid JSON.",
      );
    }
  }

  return {
    id: "tmdb",

    catalogs: CATALOG_KINDS_SUPPORTED,

    async getCatalog(
      kind: CatalogKind,
      language: string,
      signal: AbortSignal,
    ): Promise<NormalizedTitle[]> {
      const endpoint = CATALOG_ENDPOINTS[kind];
      const payload = parseOrUnavailable(
        searchResponseSchema,
        await call(endpoint.path, new URLSearchParams({ language }), signal),
      );

      return (payload.results ?? []).flatMap((raw) => {
        const item = searchItemSchema.safeParse(raw);
        if (!item.success) return [];
        const withType =
          endpoint.mediaType === undefined
            ? item.data
            : { ...item.data, media_type: endpoint.mediaType };
        const normalized = normalize(withType);
        return normalized ? [normalized] : [];
      });
    },

    supportsDiscover: true,

    async getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]> {
      const payload = parseOrUnavailable(
        genreListSchema,
        await call(`/genre/${DISCOVER_TMDB_TYPE[type]}/list`, new URLSearchParams({ language }), signal),
      );
      return (payload.genres ?? []).flatMap((raw) => {
        const g = genreItemSchema.safeParse(raw);
        // TMDB genre ids are numbers; Harbor carries them as strings.
        return g.success ? [{ id: String(g.data.id), name: g.data.name }] : [];
      });
    },

    async discoverByGenre(
      type: DiscoverType,
      genreId: string,
      page: number,
      language: string,
      signal: AbortSignal,
    ): Promise<DiscoverResult> {
      const params = new URLSearchParams({
        language,
        with_genres: genreId,
        page: String(page),
        include_adult: "false",
      });
      const payload = parseOrUnavailable(
        discoverResponseSchema,
        await call(`/discover/${DISCOVER_TMDB_TYPE[type]}`, params, signal),
      );
      // /discover/* omits media_type; inject it so normalize() keeps the rows.
      const mediaType = DISCOVER_TMDB_TYPE[type];
      const titles = (payload.results ?? []).flatMap((raw) => {
        const item = searchItemSchema.safeParse(raw);
        if (!item.success) return [];
        const normalized = normalize({ ...item.data, media_type: mediaType });
        return normalized ? [normalized] : [];
      });
      return { titles, page: payload.page, totalPages: payload.total_pages };
    },

    async validateConfiguration(signal: AbortSignal): Promise<void> {
      await call("/authentication", new URLSearchParams(), signal);
    },

    async search(
      query: MetadataSearchQuery,
      signal: AbortSignal,
    ): Promise<NormalizedTitle[]> {
      const params = new URLSearchParams({
        query: query.query,
        language: query.language,
        include_adult: "false",
      });
      const payload = parseOrUnavailable(
        searchResponseSchema,
        await call("/search/multi", params, signal),
      );
      return (payload.results ?? []).flatMap((raw) => {
        const item = searchItemSchema.safeParse(raw);
        if (!item.success) return [];
        const normalized = normalize(item.data);
        return normalized ? [normalized] : [];
      });
    },

    async getMovie(
      externalId: string,
      language: string,
      signal: AbortSignal,
    ): Promise<ProviderTitleDetail> {
      const payload = parseOrUnavailable(
        detailSchema,
        await call(
          `/movie/${encodeURIComponent(externalId)}`,
          new URLSearchParams({ language }),
          signal,
        ),
      );
      return toDetail(payload, true);
    },

    async getSeries(
      externalId: string,
      language: string,
      signal: AbortSignal,
    ): Promise<ProviderTitleDetail> {
      const payload = parseOrUnavailable(
        detailSchema,
        await call(
          `/tv/${encodeURIComponent(externalId)}`,
          new URLSearchParams({ language }),
          signal,
        ),
      );
      return toDetail(payload, false);
    },

    async getSeason(
      externalId: string,
      seasonNumber: number,
      language: string,
      signal: AbortSignal,
    ): Promise<NormalizedEpisode[]> {
      // Encoded, even though TMDB ids are numeric today: the id comes from a
      // database row, and a value with a slash in it would otherwise steer
      // the request to a different endpoint.
      const payload = parseOrUnavailable(
        seasonResponseSchema,
        await call(
          `/tv/${encodeURIComponent(externalId)}/season/${String(seasonNumber)}`,
          new URLSearchParams({ language }),
          signal,
        ),
      );

      return (payload.episodes ?? []).map((e) => ({
        episodeNumber: e.episode_number,
        name: textOrNull(e.name),
        overview: textOrNull(e.overview),
        stillPath: textOrNull(e.still_path),
        runtime: e.runtime ?? null,
        airDate: textOrNull(e.air_date),
      }));
    },
  };
}
