import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

// This file lives at src/plugins/static.ts (and compiles to dist/plugins/static.js),
// so two levels up reaches apps/server/, where the web build's outDir places `public/`.
const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

const staticPluginAsync: FastifyPluginAsync = async (fastify) => {
  if (!existsSync(PUBLIC_DIR)) {
    fastify.log.warn({ dir: PUBLIC_DIR }, "web assets missing; serving API only");
    return;
  }

  await fastify.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false });

  // Read once at registration rather than on every unmatched request: the
  // SPA fallback is the catch-all for anything that isn't a known API route
  // or static asset, so re-reading the file per hit turns any client into a
  // free syscall amplifier.
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");

  fastify.setNotFoundHandler(
    {
      // Generous on purpose: legitimate deep-link navigation (refreshing on
      // /movie/123, sharing a link, etc.) must never be throttled. This
      // exists to blunt cheap-amplification abuse (many requests forcing
      // many responses) now that @fastify/rate-limit is registered outside
      // the /api/v1 scope only, so this catch-all otherwise has no limiter.
      preHandler: fastify.rateLimit({ max: 600, timeWindow: "1 minute" }),
    },
    async (_request, reply) => reply.status(200).type("text/html").send(indexHtml),
  );
};

export const staticAssets = fp(staticPluginAsync, { name: "harbor-static", fastify: "5.x" });
