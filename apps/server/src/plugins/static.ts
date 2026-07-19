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

  const indexPath = path.join(PUBLIC_DIR, "index.html");

  fastify.setNotFoundHandler(async (_request, reply) => {
    const html = await readFile(indexPath, "utf8");
    return reply.status(200).type("text/html").send(html);
  });
};

export const staticAssets = fp(staticPluginAsync, { name: "harbor-static", fastify: "5.x" });
