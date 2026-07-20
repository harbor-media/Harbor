import { API_PREFIX, type ApiErrorBody } from "@harbor/shared";
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Second layer behind SameSite=Lax. Lax already stops browsers attaching the
 * session cookie to cross-site state-changing requests; this catches the
 * residue without the plumbing of a CSRF token.
 *
 * A missing Origin is allowed on purpose: browsers always send it on cross-site
 * mutations, so its absence means a non-browser client, which carries no
 * ambient cookie and therefore cannot be the victim of CSRF. Rejecting it would
 * break curl and API clients for no security gain.
 */
const originCheckPlugin: FastifyPluginAsync<{ baseUrl: string }> = async (fastify, opts) => {
  const expected = new URL(opts.baseUrl).origin;

  fastify.addHook("onRequest", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    const routeUrl = request.routeOptions.url;
    if (routeUrl === undefined || !routeUrl.startsWith(API_PREFIX)) return;

    const headers = request.headers;
    const rawOrigin = typeof headers.origin === "string" ? headers.origin : undefined;

    // A literal `Origin: null` is itself a browser signal — sent by sandboxed
    // iframes, some redirect chains, and file:// origins — not the absence of
    // one. `new URL("null")` throws, so without this check it would fall
    // through `originOf` to `null` and be treated as "no signal, allow" (the
    // non-browser-client path below), when it is actually the opposite: a
    // browser that has something to hide. SameSite=Lax remains the primary
    // defence either way, so this is defence-in-depth, but a literal "null"
    // should be rejected explicitly rather than silently allowed.
    if (rawOrigin === "null") {
      request.log.warn({ claimed: "null", expected }, "rejected literal null-origin request");
      const body: ApiErrorBody = {
        error: {
          code: "VALIDATION_FAILED",
          message: "Cross-origin request rejected.",
          requestId: request.id,
        },
      };
      return reply.status(403).send(body);
    }

    const claimed =
      originOf(rawOrigin) ??
      originOf(typeof headers.referer === "string" ? headers.referer : undefined);

    if (claimed === null) return;
    if (claimed === expected) return;

    request.log.warn({ claimed, expected }, "rejected cross-origin mutating request");
    const body: ApiErrorBody = {
      error: {
        code: "VALIDATION_FAILED",
        message: "Cross-origin request rejected.",
        requestId: request.id,
      },
    };
    return reply.status(403).send(body);
  });
};

export const originCheck = fp(originCheckPlugin, { name: "harbor-origin-check", fastify: "5.x" });
