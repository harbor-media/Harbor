import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import fastifyCookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { HarborEnv } from "@harbor/config";
import type { Db, Sql } from "@harbor/database";
import type { Logger } from "@harbor/logger";
import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type RawServerDefault } from "fastify";
import fp from "fastify-plugin";
import { refreshDatabaseReadiness } from "./database-lifecycle.js";
import { authRoutes } from "./modules/auth/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { installationRoutes } from "./modules/installation/routes.js";
import { invitationsRoutes } from "./modules/invitations/routes.js";
import { metadataRoutes } from "./modules/metadata/routes.js";
import { registrationRoutes } from "./modules/registration/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { setupRoutes } from "./modules/setup/routes.js";
import { authGuard } from "./plugins/auth.js";
import { context } from "./plugins/database.js";
import { errors } from "./plugins/errors.js";
import { originCheck } from "./plugins/origin.js";
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

  await app.register(fastifyCookie);
  // Registered before the auth guard so a rejected cross-origin mutation never
  // reaches the session lookup: origin is checked first because it is cheap
  // (no database access) and defends the guard's own session cookie from
  // being ridden by a forged cross-site request in the first place.
  await app.register(originCheck, { baseUrl: deps.env.HARBOR_BASE_URL });

  // Kept `global: false`: @fastify/rate-limit's own `global: true` mode
  // attaches its check to each ROUTE's local hook array via Fastify's
  // `onRoute` event, which always runs AFTER every encapsulation-level
  // `fastify.addHook('onRequest', ...)` — regardless of which plugin
  // registered first. So `global: true` could never actually run ahead of
  // authGuard's onRequest hook; only a genuine root-level `addHook` can.
  // `global: false` keeps the decorator available (`app.rateLimit(...)`,
  // used below and by /auth/login's own tighter `config.rateLimit`) without
  // that per-route auto-wiring.
  await app.register(rateLimit, { global: false });

  // A manually-invoked default budget, wired as a genuine root-level
  // `onRequest` hook registered before authGuard — this is what actually
  // bounds the guard's session lookup (a real Postgres round-trip). Fastify
  // runs root onRequest hooks in registration order, so a caller replaying a
  // bogus session cookie against any guarded route (e.g. GET /auth/me, which
  // the origin check does not cover since GET is not a mutating method)
  // now gets rate-limited before the database is ever touched, instead of
  // driving unlimited lookups — connection-pool exhaustion on a small
  // self-hosted deployment.
  //
  // Health endpoints are exempt so orchestrator polling every ~30s is never
  // throttled. Routes with their OWN `config.rateLimit` (currently just
  // /auth/login) are also skipped here and left to their route-level check
  // instead: @fastify/rate-limit tracks one "already ran" flag per request
  // (shared across every check derived from this same plugin registration),
  // so running the generic 100/minute check first would silently prevent
  // login's tighter 30/minute check from ever running.
  //
  // Wrapped in its own plugin (rather than calling `app.rateLimit(...)`
  // inline here) because `await app.register(rateLimit, ...)` above only
  // queues that plugin — its body, and the `rateLimit` decorator it adds,
  // do not actually run until boot. Registering this as a plugin lets avvio
  // run it in the same sequential order, guaranteeing the decorator exists
  // by the time this body executes, while still calling `addHook` before
  // authGuard's own registration.
  const defaultRateLimitPlugin: FastifyPluginAsync = async (fastify) => {
    const defaultRateLimit = fastify.rateLimit({ max: 100, timeWindow: "1 minute" });
    fastify.addHook("onRequest", async (request, reply) => {
      const routeUrl = request.routeOptions.url;
      if (routeUrl === undefined || !routeUrl.startsWith(API_PREFIX)) return;
      if (HEALTH_PATHS.has(routeUrl)) return;
      if (request.routeOptions.config?.rateLimit) return;
      await defaultRateLimit.call(fastify, request, reply);
    });
  };
  await app.register(fp(defaultRateLimitPlugin, { name: "harbor-default-rate-limit" }));

  // Registered at root (fastify-plugin breaks encapsulation) so its
  // onRequest hook installs ahead of every route, including ones added by
  // later plugins. This is what makes the guard fail closed by default:
  // a new route needs no opt-in to be protected. Registered after the rate
  // limit hook above so the session lookup inside the guard is always
  // bounded.
  await app.register(authGuard);

  // A self-hosted SPA serving only its own bundled assets: no third-party
  // script/style/font/image origins are ever legitimate, so `default-src
  // 'self'` needs no loosening. Vite's production build emits an external
  // <script type="module"> and an external stylesheet, never inline script
  // or style, so `unsafe-inline` is not required either. `frame-ancestors
  // 'none'` (plus the legacy X-Frame-Options fallback) means Harbor can never
  // be framed by another site. HSTS is intentionally left off: TLS
  // terminates at the operator's reverse proxy, and Harbor has no way to
  // know whether the connection in front of it is actually HTTPS.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: "deny" },
    hsts: false,
  });

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

      await api.register(healthRoutes);
      await api.register(installationRoutes);
      await api.register(setupRoutes);
      await api.register(authRoutes);
      await api.register(invitationsRoutes);
      await api.register(metadataRoutes);
      await api.register(registrationRoutes);
      await api.register(settingsRoutes);
    },
    { prefix: API_PREFIX },
  );

  await app.register(staticAssets);

  return app;
}
