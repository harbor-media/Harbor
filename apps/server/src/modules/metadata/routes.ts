import { encryptSecret } from "@harbor/crypto";
import { getMetadataProviderConfig, saveMetadataProviderConfig } from "@harbor/database";
import type { MetadataConfigStatus, SearchResponse } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HarborError } from "../../plugins/errors.js";
import { requireRole } from "../../plugins/require-role.js";
import { MetadataNotConfiguredError, tmdbFactory } from "./config.js";
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
};
