import type { NormalizedEpisode, NormalizedSeason, NormalizedTitle } from "@harbor/database";
import type { CatalogKind, DiscoverType, Genre } from "@harbor/shared";

export type MetadataFailureKind = "unauthorized" | "unavailable";

export class MetadataProviderError extends Error {
  constructor(
    readonly kind: MetadataFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "MetadataProviderError";
  }
}

export interface MetadataSearchQuery {
  query: string;
  language: string;
}

/** Everything a detail page needs beyond what search already returned. */
export interface ProviderTitleDetail {
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  genres: string[];
  /** Always empty for a movie, so callers need no type test. */
  seasons: NormalizedSeason[];
}

export interface DiscoverResult {
  titles: NormalizedTitle[];
  page: number;
  totalPages: number;
}

/**
 * CLAUDE.md sketches a six-method provider interface. Five are declared here.
 *
 * getEpisode is deliberately absent: a provider season payload already
 * carries its whole episode list, so fetching episodes one at a time would
 * issue more requests for exactly the same data. It arrives only if a
 * provider appears that requires per-episode fetching. The rule from Phase
 * 3a still holds -- declare only the methods that can be honored, because a
 * method that throws NotImplemented makes the contract a lie.
 */
export interface MetadataProvider {
  readonly id: string;
  /** Resolves when the credential works; throws MetadataProviderError otherwise. */
  validateConfiguration(signal: AbortSignal): Promise<void>;
  search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]>;
  getMovie(externalId: string, language: string, signal: AbortSignal): Promise<ProviderTitleDetail>;
  getSeries(externalId: string, language: string, signal: AbortSignal): Promise<ProviderTitleDetail>;
  getSeason(
    externalId: string,
    seasonNumber: number,
    language: string,
    signal: AbortSignal,
  ): Promise<NormalizedEpisode[]>;
  /**
   * The catalog kinds this provider can actually serve.
   *
   * A capability list rather than four methods, because the rule above still
   * holds: a method that throws NotImplemented makes the contract a lie. A
   * provider that cannot serve New Releases omits the kind and Harbor hides
   * that row instead of rendering an error.
   */
  readonly catalogs: readonly CatalogKind[];
  getCatalog(
    kind: CatalogKind,
    language: string,
    signal: AbortSignal,
  ): Promise<NormalizedTitle[]>;
  /**
   * Whether this provider can browse by genre. A capability flag, not a
   * throwing method: a provider that cannot discover sets this false and
   * Harbor hides the feature rather than erroring.
   */
  readonly supportsDiscover: boolean;
  getGenres(type: DiscoverType, language: string, signal: AbortSignal): Promise<Genre[]>;
  discoverByGenre(
    type: DiscoverType,
    genreId: string,
    page: number,
    language: string,
    signal: AbortSignal,
  ): Promise<DiscoverResult>;
}
