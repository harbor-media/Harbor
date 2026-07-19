import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import rateLimit from "@fastify/rate-limit";
import type { HarborEnv } from "@harbor/config";
import type { Db, Sql } from "@harbor/database";
import type { Logger } from "@harbor/logger";
import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import { healthRoutes } from "./modules/health/routes.js";
import { installationRoutes } from "./modules/installation/routes.js";
import { context } from "./plugins/database.js";
import { errors } from "./plugins/errors.js";
import { staticAssets } from "./plugins/static.js";
import type { RuntimeState } from "./state.js";

export interface AppDeps {
  env: HarborEnv;
  logger: Logger;
  db: Db;
  sql: Sql;
  state: RuntimeState;
}

export type HarborApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

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

      await api.register(rateLimit, { global: false });
      await api.register(healthRoutes);
      await api.register(installationRoutes);
    },
    { prefix: API_PREFIX },
  );

  await app.register(staticAssets);

  return app;
}
