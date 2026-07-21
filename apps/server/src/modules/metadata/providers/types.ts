import type { NormalizedTitle } from "@harbor/database";

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

/**
 * CLAUDE.md sketches a six-method provider interface. Only the two methods
 * Phase 3a can honor are declared here; the detail methods (getMovie,
 * getSeries, getSeason, getEpisode) arrive in Phase 3c alongside the pages
 * that consume them. Declaring methods that throw NotImplemented would make
 * the contract a lie and invite callers to code against stubs.
 */
export interface MetadataProvider {
  readonly id: string;
  /** Resolves when the credential works; throws MetadataProviderError otherwise. */
  validateConfiguration(signal: AbortSignal): Promise<void>;
  search(query: MetadataSearchQuery, signal: AbortSignal): Promise<NormalizedTitle[]>;
}
