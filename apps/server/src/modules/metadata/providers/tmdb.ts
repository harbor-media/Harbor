import type { NormalizedTitle } from "@harbor/database";
import {
  MetadataProviderError,
  type MetadataProvider,
  type MetadataSearchQuery,
} from "./types.js";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

interface TmdbSearchItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
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
  async function call(path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}?${params.toString()}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
        signal,
      });
    } catch {
      // The upstream error is deliberately swallowed rather than chained: it
      // can contain the request URL and header material.
      throw new MetadataProviderError("unavailable", "The metadata provider could not be reached.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new MetadataProviderError("unauthorized", "The metadata provider rejected the API key.");
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
      throw new MetadataProviderError("unavailable", "The metadata provider returned invalid JSON.");
    }
  }

  return {
    id: "tmdb",

    async validateConfiguration(signal: AbortSignal): Promise<void> {
      await call("/authentication", new URLSearchParams(), signal);
    },

    async search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]> {
      const params = new URLSearchParams({
        query: query.query,
        language: query.language,
        include_adult: "false",
      });
      const payload = (await call("/search/multi", params, signal)) as {
        results?: TmdbSearchItem[];
      };
      return (payload.results ?? []).flatMap((item) => {
        const normalized = normalize(item);
        return normalized ? [normalized] : [];
      });
    },
  };
}
