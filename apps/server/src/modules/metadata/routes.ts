import { encryptSecret, SecretDecryptionError } from "@harbor/crypto";
import { getMetadataProviderConfig, saveMetadataProviderConfig } from "@harbor/database";
import {
  CATALOG_KINDS,
  type CatalogRowResponse,
  type DiscoverResponse,
  type GenreListResponse,
  type MetadataConfigStatus,
  type SearchResponse,
  type SeasonResponse,
  type TitleDetailResponse,
} from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { requireRole } from "../../plugins/require-role.js";
import { CatalogKindUnsupportedError, fetchCatalogRow } from "./catalog.js";
import { DiscoverUnsupportedError, fetchDiscover, fetchGenres } from "./discover.js";
import { MetadataNotConfiguredError, tmdbFactory } from "./config.js";
import { fetchSeasonDetail, fetchTitleDetail, TitleNotFoundError } from "./detail.js";
import { MetadataProviderError } from "./providers/types.js";
import { searchTitles } from "./search.js";

const VALIDATE_TIMEOUT_MS = 10_000;

const ConfigSchema = z.object({
  apiKey: z.string().min(1).max(512),
  language: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/, "Language must look like en-US.")
    .default("en-US"),
  enabled: z.boolean().default(true),
});

const SearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) });

const TitleParamsSchema = z.object({ id: z.uuid() });

const SeasonParamsSchema = z.object({
  id: z.uuid(),
  season: z.coerce.number().int().min(0).max(1000),
});

// z.enum over the shared tuple, so an unknown kind is a 400 from validation
// rather than a lookup miss deeper in the stack.
const CatalogParamsSchema = z.object({ kind: z.enum(CATALOG_KINDS) });

const DiscoverTypeSchema = z.enum(["movie", "series"]);
const GenreParamsSchema = z.object({ type: DiscoverTypeSchema });
const DiscoverParamsSchema = z.object({
  type: DiscoverTypeSchema,
  // Numeric string; TMDB genre ids are integers.
  genreId: z.string().regex(/^\d+$/, "Genre id must be numeric."),
});
const DiscoverQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
});

function toStatus(
  row: { enabled: boolean; encryptedApiKey: string | null; language: string; lastVerifiedAt: Date | null } | null,
): MetadataConfigStatus {
  return {
    configured: row?.encryptedApiKey != null,
    enabled: row?.enabled ?? false,
    language: row?.language ?? "en-US",
    lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
  };
}

/** Translates domain failures into the API error contract. Provider error
 *  text is never forwarded: it can name upstream hosts and request details. */
function toHarborError(error: unknown): HarborError {
  if (error instanceof MetadataNotConfiguredError) {
    return new HarborError(
      "METADATA_NOT_CONFIGURED",
      "No metadata provider is configured. An administrator can set one up in Settings.",
      409,
    );
  }
  if (error instanceof TitleNotFoundError) {
    // 404 rather than a provider error: the title id is the clients problem,
    // not the providers, and conflating them would send an operator looking
    // at TMDB when the request simply named something that does not exist.
    return new HarborError("NOT_FOUND", "Title not found.", 404);
  }
  if (error instanceof CatalogKindUnsupportedError) {
    // 409, not 404: the row is a real concept, this installation's provider
    // just cannot serve it. The client hides the row rather than showing an
    // error, and an operator reading logs sees a capability gap, not a bug.
    return new HarborError("CATALOG_KIND_UNSUPPORTED", error.message, 409);
  }
  if (error instanceof DiscoverUnsupportedError) {
    // 409: browsing by genre is a real feature this installation's provider
    // cannot offer. The page treats it as unavailable, not an error.
    return new HarborError("DISCOVER_UNSUPPORTED", error.message, 409);
  }
  // A stored key that will not decrypt means HARBOR_SECRET changed. Left
  // unmapped this returns a generic 500, which tells an operator nothing and
  // sends them hunting a server fault -- while the config endpoint still
  // reports the provider as configured. The corrective action is specific and
  // only they can take it, so it must reach them rather than only the log.
  if (error instanceof SecretDecryptionError) {
    return new HarborError(
      "METADATA_KEY_UNREADABLE",
      "The stored metadata API key could not be decrypted. This happens when HARBOR_SECRET changes. Re-enter the provider key in metadata settings.",
      409,
    );
  }
  if (error instanceof MetadataProviderError) {
    return error.kind === "unauthorized"
      ? new HarborError(
          "METADATA_PROVIDER_UNAUTHORIZED",
          "The metadata provider rejected Harbor's API key. An administrator must update it.",
          502,
        )
      : new HarborError(
          "METADATA_PROVIDER_UNAVAILABLE",
          "The metadata provider is currently unreachable. Try again shortly.",
          503,
        );
  }
  throw error;
}

export const metadataRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/admin/metadata/config",
    { preHandler: [requireRole("administrator")] },
    async (): Promise<MetadataConfigStatus> => {
      return toStatus(await getMetadataProviderConfig(fastify.db, "tmdb"));
    },
  );

  fastify.post(
    "/admin/metadata/test",
    {
      preHandler: [requireRole("administrator")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request): Promise<{ valid: true }> => {
      const parsed = ConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      try {
        await tmdbFactory(fastify.env.HARBOR_TMDB_BASE_URL)(parsed.data.apiKey).validateConfiguration(
          AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        );
      } catch (error) {
        throw toHarborError(error);
      }
      return { valid: true };
    },
  );

  fastify.put(
    "/admin/metadata/config",
    {
      preHandler: [requireRole("administrator")],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request): Promise<MetadataConfigStatus> => {
      const parsed = ConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      const { apiKey, language, enabled } = parsed.data;

      // Validate before persisting, so an administrator cannot save a key
      // that does not work and then wonder why search is broken.
      try {
        await tmdbFactory(fastify.env.HARBOR_TMDB_BASE_URL)(apiKey).validateConfiguration(
          AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        );
      } catch (error) {
        throw toHarborError(error);
      }

      await saveMetadataProviderConfig(fastify.db, {
        providerId: "tmdb",
        enabled,
        encryptedApiKey: encryptSecret(apiKey, fastify.env.HARBOR_SECRET),
        language,
        lastVerifiedAt: new Date(),
      });

      fastify.log.info({ providerId: "tmdb" }, "metadata provider configured");
      return toStatus(await getMetadataProviderConfig(fastify.db, "tmdb"));
    },
  );

  fastify.get(
    "/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request): Promise<SearchResponse> => {
      const parsed = SearchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      try {
        return await searchTitles(
          {
            db: fastify.db,
            harborSecret: fastify.env.HARBOR_SECRET,
            tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL,
          },
          parsed.data.q,
        );
      } catch (error) {
        throw toHarborError(error);
      }
    },
  );

  // Generous compared with /search: opening one title page issues a detail
  // request plus one per season tab the viewer opens, so the search limit
  // would fire during ordinary browsing.
  const detailRateLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  fastify.get("/titles/:id", detailRateLimit, async (request): Promise<TitleDetailResponse> => {
    const parsed = TitleParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
    }
    try {
      return await fetchTitleDetail(
        {
          db: fastify.db,
          harborSecret: fastify.env.HARBOR_SECRET,
          tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL,
        },
        parsed.data.id,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });

  fastify.get("/catalog/:kind", detailRateLimit, async (request): Promise<CatalogRowResponse> => {
    const parsed = CatalogParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
    }
    try {
      return await fetchCatalogRow(
        {
          db: fastify.db,
          harborSecret: fastify.env.HARBOR_SECRET,
          tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL,
        },
        parsed.data.kind,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });

  fastify.get("/genres/:type", detailRateLimit, async (request): Promise<GenreListResponse> => {
    const parsed = GenreParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
    }
    try {
      return await fetchGenres(
        { db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET, tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL },
        parsed.data.type,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });

  fastify.get("/discover/:type/:genreId", detailRateLimit, async (request): Promise<DiscoverResponse> => {
    const params = DiscoverParamsSchema.safeParse(request.params);
    const query = DiscoverQuerySchema.safeParse(request.query);
    if (!params.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(params.error), 400);
    }
    if (!query.success) {
      throw new HarborError("VALIDATION_FAILED", z.prettifyError(query.error), 400);
    }
    try {
      return await fetchDiscover(
        { db: fastify.db, harborSecret: fastify.env.HARBOR_SECRET, tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL },
        params.data.type,
        params.data.genreId,
        query.data.page,
      );
    } catch (error) {
      throw toHarborError(error);
    }
  });

  fastify.get(
    "/titles/:id/seasons/:season",
    detailRateLimit,
    async (request): Promise<SeasonResponse> => {
      const parsed = SeasonParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        throw new HarborError("VALIDATION_FAILED", z.prettifyError(parsed.error), 400);
      }
      try {
        return await fetchSeasonDetail(
          {
            db: fastify.db,
            harborSecret: fastify.env.HARBOR_SECRET,
            tmdbBaseUrl: fastify.env.HARBOR_TMDB_BASE_URL,
          },
          parsed.data.id,
          parsed.data.season,
        );
      } catch (error) {
        throw toHarborError(error);
      }
    },
  );
};
