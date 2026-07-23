import {
  getCatalogFetchedAt,
  listCatalogTitles,
  saveCatalogRow,
  type Db,
  type StoredCatalogTitle,
} from "@harbor/database";
import type { CatalogKind, CatalogRowResponse, TitleCard } from "@harbor/shared";
import { loadProvider } from "./config.js";
import { MetadataProviderError, type MetadataProvider } from "./providers/types.js";

/**
 * Six hours. Trending genuinely moves day to day; "popular" barely moves week
 * to week. One constant covers both: four upstream calls per six hours for the
 * entire server is far inside any provider's budget, and a second freshness
 * concept would buy nothing at this scale.
 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export class CatalogKindUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogKindUnsupportedError";
  }
}

export interface CatalogDeps {
  db: Db;
  harborSecret: string;
  now?: () => Date;
  providerFactory?: (apiKey: string) => MetadataProvider;
  tmdbBaseUrl?: string;
}

function toCard(row: StoredCatalogTitle): TitleCard {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    year: row.year,
    posterPath: row.posterPath,
  };
}

async function respond(
  deps: CatalogDeps,
  kind: CatalogKind,
  cached: boolean,
): Promise<CatalogRowResponse> {
  const rows = await listCatalogTitles(deps.db, kind);
  return { kind, titles: rows.map(toCard), cached };
}

function isFresh(fetchedAt: Date | null, now: Date): boolean {
  if (fetchedAt === null) return false;
  return now.getTime() - fetchedAt.getTime() <= CATALOG_TTL_MS;
}

export async function fetchCatalogRow(
  deps: CatalogDeps,
  kind: CatalogKind,
): Promise<CatalogRowResponse> {
  const now = deps.now ?? (() => new Date());

  const fetchedAt = await getCatalogFetchedAt(deps.db, kind);
  if (isFresh(fetchedAt, now())) {
    return respond(deps, kind, true);
  }

  const { provider, language } = await loadProvider(
    deps.db,
    deps.harborSecret,
    deps.providerFactory,
    deps.tmdbBaseUrl,
  );

  if (!provider.catalogs.includes(kind)) {
    throw new CatalogKindUnsupportedError(`The configured provider cannot serve "${kind}".`);
  }

  let titles: Awaited<ReturnType<typeof provider.getCatalog>>;
  try {
    titles = await provider.getCatalog(kind, language, AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch (error) {
    // Same rule as title detail: an outage degrades to stale data, a rejected
    // key does not. Serving stale over a broken credential hides a problem
    // only an administrator can fix.
    if (
      error instanceof MetadataProviderError &&
      error.kind === "unavailable" &&
      fetchedAt !== null
    ) {
      return respond(deps, kind, true);
    }
    throw error;
  }

  await saveCatalogRow(deps.db, kind, titles, now());
  return respond(deps, kind, false);
}
