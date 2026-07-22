import { findSessionByTokenHash, touchSession, type Session } from "@harbor/database";
import { API_PREFIX, type ApiErrorBody, type AuthenticatedUser } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { refreshDatabaseReadiness } from "../database-lifecycle.js";
import { SESSION_COOKIE } from "../modules/auth/cookies.js";
import { hashSessionToken } from "../modules/auth/tokens.js";
import { isReady } from "../state.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
    session: Session | null;
  }
}

/**
 * Exact "METHOD /path" matches only — never prefixes. A prefix entry such as
 * "/api/v1/auth" would also expose "/api/v1/auth/sessions".
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  `GET ${API_PREFIX}/health`,
  `GET ${API_PREFIX}/health/live`,
  `GET ${API_PREFIX}/health/ready`,
  // HEAD as well as GET. Fastify auto-generates a HEAD route for every GET,
  // and health probes commonly use HEAD -- `wget --spider`, which is exactly
  // what this image's HEALTHCHECK runs, does. Because matching here is on the
  // literal "METHOD /path", listing only GET left HEAD guarded, so the
  // container healthcheck got a 401 against a perfectly healthy server and
  // never passed. That makes `depends_on: service_healthy` hang and an
  // orchestrator restart a container that is fine.
  `HEAD ${API_PREFIX}/health`,
  `HEAD ${API_PREFIX}/health/live`,
  `HEAD ${API_PREFIX}/health/ready`,
  `GET ${API_PREFIX}/installation/state`,
  `POST ${API_PREFIX}/setup`,
  `POST ${API_PREFIX}/auth/login`,
  // Logout is public on purpose: an expired or already-revoked session must
  // still be able to clear its cookie. Guarding it would 401 before the handler
  // runs, leaving a stale cookie in the browser forever. The handler is
  // idempotent and reveals nothing (see Task 12).
  `POST ${API_PREFIX}/auth/logout`,
  // Public invite inspection: matched against the ROUTE PATTERN (routeOptions.url),
  // so the :token param appears literally here. Returns an identical negative
  // response for every non-active token, so it reveals nothing.
  `GET ${API_PREFIX}/invitations/:token`,
  // Registration is public by design: invitation-only mode is bounded by needing
  // a valid token; open mode is bounded by this route's own rate limit.
  `POST ${API_PREFIX}/register`,
]);

function unauthorized(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
      requestId: request.id,
    },
  };
  return reply.status(401).send(body);
}

function notReady(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const body: ApiErrorBody = {
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Harbor is starting up. Try again shortly.",
      requestId: request.id,
    },
  };
  return reply.status(503).send(body);
}

const authGuardPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest("user", null);
  fastify.decorateRequest("session", null);

  fastify.addHook("onRequest", async (request, reply) => {
    // Routing runs before onRequest, so the matched route pattern is known here.
    const routeUrl = request.routeOptions.url;

    // No matched route: the 404 handlers own the response.
    if (routeUrl === undefined) return;

    // Static assets and the SPA shell are public by nature.
    if (!routeUrl.startsWith(API_PREFIX)) return;

    if (PUBLIC_ROUTES.has(`${request.method} ${routeUrl}`)) return;

    // This plugin is registered at root, so its hook runs BEFORE the API
    // scope's readiness gate. Without this check the session lookup below would
    // hit a database that may be unreachable or unmigrated and surface a 500,
    // overriding Phase 1's contract that non-health API routes answer 503 while
    // Harbor is starting. Returning the reply here (rather than falling
    // through) keeps the guard fail-closed: the request never reaches a handler.
    // Public routes are checked first, so health and readiness probes — the
    // paths that actually refresh readiness — are unaffected.
    //
    // `isReady` alone only reads the cached flag, which is refreshed on the API
    // scope's readiness hook — but that hook runs AFTER this one, so a cached
    // `databaseReady: true` from before an outage would otherwise survive long
    // enough for the session lookup below to hit a dead connection and surface
    // a raw 500 instead of 503. Refreshing here first closes that gap; the
    // refresh itself is a no-op (TTL-guarded) when a probe already ran recently,
    // so this does not add a database round-trip to every request.
    await refreshDatabaseReadiness(
      fastify.state,
      fastify.env,
      fastify.db,
      fastify.sql,
      request.log,
    );
    if (!isReady(fastify.state)) return notReady(request, reply);

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return unauthorized(request, reply);

    const found = await findSessionByTokenHash(fastify.db, hashSessionToken(token));
    if (!found) return unauthorized(request, reply);

    if (found.session.expiresAt.getTime() <= Date.now()) {
      return unauthorized(request, reply);
    }

    request.session = found.session;
    request.user = {
      id: found.user.id,
      username: found.user.username,
      email: found.user.email,
      role: found.user.role,
    };

    // Fire-and-forget: a failed timestamp refresh must not fail the request.
    // Wrapped in Promise.resolve() because touchSession's return value isn't
    // trusted to always be a real promise (e.g. a test double).
    void Promise.resolve(touchSession(fastify.db, found.session.id)).catch((error: unknown) => {
      request.log.warn({ err: error }, "failed to refresh session last_seen_at");
    });
    return undefined;
  });
};

export const authGuard = fp(authGuardPlugin, { name: "harbor-auth-guard", fastify: "5.x" });
