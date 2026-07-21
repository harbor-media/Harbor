import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { HarborError } from "../../plugins/errors.js";
import { IMAGE_PROVIDERS, type ImageProviderId } from "./providers.js";
import { ImageService } from "./service.js";
import { ImageFetchError } from "./upstream.js";
import { InvalidImageRequestError, parseImageRequest } from "./validate.js";

/**
 * Provider artwork is content-addressed and effectively immutable, so it can
 * be cached hard. `private` because the route is authenticated: a shared
 * cache must never hand one user's response to another.
 */
const CACHE_CONTROL = "private, max-age=604800, immutable";

interface ImageParams {
  provider: string;
  size: string;
  file: string;
}

export const imageRoutes: FastifyPluginAsync = async (fastify) => {
  const baseUrls = {
    tmdb: fastify.env.HARBOR_TMDB_IMAGE_BASE_URL ?? IMAGE_PROVIDERS.tmdb.defaultBaseUrl,
  } satisfies Record<ImageProviderId, string>;

  const service = new ImageService({
    cacheRoot: path.join(fastify.env.HARBOR_DATA_DIRECTORY, "cache", "images"),
    baseUrls,
    logger: fastify.log,
  });

  fastify.get(
    "/images/:provider/:size/:file",
    // Generous: a catalog page requests many posters at once, and a limit that
    // fires during normal browsing would be worse than the abuse it prevents.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const params = request.params as ImageParams;

      let parsed;
      try {
        parsed = parseImageRequest(params.provider, params.size, params.file);
      } catch (error) {
        if (error instanceof InvalidImageRequestError) {
          throw new HarborError("VALIDATION_FAILED", error.message, 400);
        }
        throw error;
      }

      let served;
      try {
        served = await service.serve(parsed);
      } catch (error) {
        if (error instanceof ImageFetchError) {
          if (error.kind === "not-found") {
            throw new HarborError("NOT_FOUND", "Image not found.", 404);
          }
          // Upstream text is never forwarded: it can name hosts and request
          // details. The kind picks the status; the message stays fixed.
          throw new HarborError(
            "IMAGE_UNAVAILABLE",
            "The image could not be retrieved.",
            error.kind === "unavailable" ? 503 : 502,
          );
        }
        throw error;
      }

      // nosniff matters most here: it stops a browser re-interpreting a
      // response as something executable regardless of the declared type.
      void reply.header("x-content-type-options", "nosniff");
      void reply.header("cache-control", CACHE_CONTROL);
      void reply.type(served.contentType);

      if (served.kind === "stream") {
        return reply.send(served.body);
      }

      // Weak validator from size and mtime. Hashing the bytes would mean
      // reading every cached file in full on every request purely to build a
      // header, and provider paths are already content-addressed.
      const etag = `W/"${served.size.toString(16)}-${Math.floor(served.mtimeMs).toString(16)}"`;
      void reply.header("etag", etag);

      if (request.headers["if-none-match"] === etag) {
        return reply.status(304).send();
      }

      void reply.header("content-length", served.size);
      return reply.send(createReadStream(served.path));
    },
  );
};
