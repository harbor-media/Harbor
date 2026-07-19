import type { HealthStatus, ReadinessStatus } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { isReady } from "../../state.js";

export const HARBOR_VERSION = process.env["HARBOR_VERSION"] ?? "0.1.0-dev";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness deliberately checks nothing external. A failing metadata provider
  // or database must never cause the orchestrator to restart the container.
  fastify.get("/health/live", async (): Promise<{ status: "ok" }> => ({ status: "ok" }));

  fastify.get("/health/ready", async (_request, reply): Promise<ReadinessStatus> => {
    const { state } = fastify;
    const payload: ReadinessStatus = {
      ready: isReady(state),
      checks: {
        database: state.databaseReady,
        migrations: state.migrationsApplied,
        dataDirectory: state.dataDirectoryWritable,
      },
    };
    void reply.status(payload.ready ? 200 : 503);
    return payload;
  });

  fastify.get("/health", async (): Promise<HealthStatus> => {
    const { state } = fastify;
    return {
      status: isReady(state) ? "ok" : "degraded",
      version: HARBOR_VERSION,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    };
  });
};
