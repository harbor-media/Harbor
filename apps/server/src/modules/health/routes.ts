import type { Sql } from "@harbor/database";
import type { HealthStatus, ReadinessStatus } from "@harbor/shared";
import type { FastifyPluginAsync } from "fastify";
import { isReady, READINESS_PROBE_TTL_MS, type RuntimeState } from "../../state.js";

export const HARBOR_VERSION = process.env["HARBOR_VERSION"] ?? "0.1.0-dev";

/**
 * Bound how long a hung database can make the readiness endpoint itself
 * hang. A dead-but-not-refusing connection (firewall black hole, overloaded
 * host) must still produce a prompt 503 rather than stalling the request.
 */
const DATABASE_PROBE_TIMEOUT_MS = 2_000;

async function probeDatabase(sql: Sql, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("database readiness probe timed out"));
        }, timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Refresh `state.databaseReady` from a live query when the cached result has
 * gone stale. Boot sets the readiness flags once and never revisits them, so
 * without this a database outage after boot would leave readiness reporting
 * healthy indefinitely. The result is cached for `READINESS_PROBE_TTL_MS` so
 * orchestrator polling doesn't turn into a database round-trip per request.
 */
async function refreshDatabaseReadiness(state: RuntimeState, sql: Sql): Promise<void> {
  const now = Date.now();
  if (now - state.databaseProbedAt < READINESS_PROBE_TTL_MS) {
    return;
  }
  state.databaseReady = await probeDatabase(sql, DATABASE_PROBE_TIMEOUT_MS);
  state.databaseProbedAt = Date.now();
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness deliberately checks nothing external. A failing metadata provider
  // or database must never cause the orchestrator to restart the container.
  fastify.get("/health/live", async (): Promise<{ status: "ok" }> => ({ status: "ok" }));

  fastify.get("/health/ready", async (_request, reply): Promise<ReadinessStatus> => {
    const { state, sql } = fastify;

    await refreshDatabaseReadiness(state, sql);

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
