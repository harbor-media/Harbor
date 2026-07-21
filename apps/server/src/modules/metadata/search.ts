import { createHash } from "node:crypto";
import {
  getTitlesByIds,
  readSearchCache,
  upsertTitles,
  writeSearchCache,
  type Db,
  type StoredTitle,
} from "@harbor/database";
import type { SearchResponse, SearchResultItem } from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

const PROVIDER_TIMEOUT_MS = 10_000;

export interface SearchDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
}

/** Normalizes case and surrounding whitespace so trivially different
 *  spellings of the same search share one cache entry. */
export function hashSearchQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase(), "utf8").digest("hex");
}

function toResultItem(title: StoredTitle): SearchResultItem {
  return {
    id: title.id,
    type: title.type,
    title: title.title,
    year: title.year,
    overview: title.overview,
    posterPath: title.posterPath,
  };
}

export async function searchTitles(deps: SearchDeps, rawQuery: string): Promise<SearchResponse> {
  const now = deps.now ?? (() => new Date());
  const { provider, language } = await loadProvider(deps.db, deps.harborSecret, deps.providerFactory);
  const queryHash = hashSearchQuery(rawQuery);

  const cachedIds = await readSearchCache(deps.db, queryHash, language, now());
  if (cachedIds) {
    return { results: (await getTitlesByIds(deps.db, cachedIds)).map(toResultItem), cached: true };
  }

  let normalized;
  try {
    normalized = await provider.search(
      { query: rawQuery.trim(), language },
      AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    );
  } catch (error) {
    // A provider outage should degrade to stale results rather than an error
    // page. Expiry is a freshness preference; an outage is not a reason to
    // withhold data Harbor already has.
    if (error instanceof MetadataProviderError && error.kind === "unavailable") {
      const stale = await readSearchCache(deps.db, queryHash, language, new Date(0));
      if (stale) {
        return { results: (await getTitlesByIds(deps.db, stale)).map(toResultItem), cached: true };
      }
    }
    throw error;
  }

  const ids = await upsertTitles(deps.db, normalized);
  await writeSearchCache(deps.db, queryHash, language, ids);

  return { results: (await getTitlesByIds(deps.db, ids)).map(toResultItem), cached: false };
}
