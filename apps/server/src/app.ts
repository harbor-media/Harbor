import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import rateLimit from "@fastify/rate-limit";
import type { HarborEnv } from "@harbor/config";
import type { Db, Sql } from "@harbor/database";
import type { Logger } from "@harbor/logger";
import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import { refreshDatabaseReadiness } from "./database-lifecycle.js";
import { healthRoutes } from "./modules/health/routes.js";
import { installationRoutes } from "./modules/installation/routes.js";
import { context } from "./plugins/database.js";
import { errors } from "./plugins/errors.js";
import { staticAssets } from "./plugins/static.js";
import { isReady, type RuntimeState } from "./state.js";

export interface AppDeps {
  env: HarborEnv;
  logger: Logger;
  db: Db;
  sql: Sql;
  state: RuntimeState;
}

export type HarborApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

// Health endpoints must stay reachable regardless of readiness state, or the
// orchestrator polling /health/ready can never observe recovery. Matched
// against the path only (query string stripped) so `?x=1` can't smuggle a
// request past the check.
const HEALTH_PATHS = new Set([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/health/live`,
  `${API_PREFIX}/health/ready`,
]);

export async function createApp(deps: AppDeps): Promise<HarborApp> {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: deps.env.HARBOR_TRUST_PROXY,
    disableRequestLogging: false,
    genReqId(): string {
      return randomUUID();
    },
  });

  await app.register(context, { db: deps.db, sql: deps.sql, state: deps.state, env: deps.env });
  await app.register(errors);

  await app.register(
    async (api) => {
      api.setNotFoundHandler((request, reply) => {
        const payload: ApiErrorBody = {
          error: { code: "NOT_FOUND", message: "Route not found.", requestId: request.id },
        };
        void reply.status(404).send(payload);
      });

      // Non-health API routes return 503 while Harbor is not ready, rather
      // than reaching handlers that query tables that may not exist yet
      // (pre-migration) or a database that is unreachable. Health endpoints
      // are exempt so the orchestrator can always observe live/ready state.
      // The static/SPA plugin below is registered outside this scope and so
      // is deliberately NOT gated: serving the app shell lets the frontend
      // render its own "starting up" state instead of a bare 503, at the
      // cost of the shell then calling an API that itself 503s until ready
      // — an acceptable tradeoff since the shell can retry.
      api.addHook("onRequest", async (request, reply) => {
        const path = request.url.split("?")[0] ?? request.url;
        if (HEALTH_PATHS.has(path)) return;

        await refreshDatabaseReadiness(deps.state, deps.env, deps.db, deps.sql, request.log);

        if (!isReady(deps.state)) {
          const payload: ApiErrorBody = {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Harbor is starting up. Try again shortly.",
              requestId: request.id,
            },
          };
          return reply.status(503).send(payload);
        }
        return undefined;
      });

      await api.register(rateLimit, { global: false });
      await api.register(healthRoutes);
      await api.register(installationRoutes);
    },
    { prefix: API_PREFIX },
  );

  await app.register(staticAssets);

  return app;
}
