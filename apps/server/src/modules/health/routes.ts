import type { HealthStatus, ReadinessStatus } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { refreshDatabaseReadiness } from "../../database-lifecycle.js";
import { isReady } from "../../state.js";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness deliberately checks nothing external. A failing metadata provider
  // or database must never cause the orchestrator to restart the container.
  fastify.get("/health/live", async (): Promise<{ status: "ok" }> => ({ status: "ok" }));

  fastify.get("/health/ready", async (_request, reply): Promise<ReadinessStatus> => {
    const { state, sql, db, env, log } = fastify;

    await refreshDatabaseReadiness(state, env, db, sql, log);

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
    const { state, env } = fastify;
    return {
      status: isReady(state) ? "ok" : "degraded",
      version: env.HARBOR_VERSION,
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    };
  });
};
