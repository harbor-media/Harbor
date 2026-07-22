import type { NormalizedEpisode, NormalizedSeason, NormalizedTitle } from "@harbor/database";

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
}
