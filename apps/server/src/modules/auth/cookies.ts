import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import { SESSION_TTL_MS } from "./tokens.js";

export const SESSION_COOKIE = "harbor_session";

/**
 * `secure` is derived from the deployment's own base URL rather than hardcoded.
 * Hardcoding true breaks plain-http local development in a confusing way: the
 * browser drops the cookie silently, so login looks successful but no session
 * persists. Phase 1 already constrains HARBOR_BASE_URL to http or https.
 */
export function cookieOptions(baseUrl: string): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, baseUrl: string): void {
  void reply.setCookie(SESSION_COOKIE, token, cookieOptions(baseUrl));
}

/** Path must match the one used when setting, or the browser keeps the original. */
export function clearSessionCookie(reply: FastifyReply, baseUrl: string): void {
  void reply.clearCookie(SESSION_COOKIE, { ...cookieOptions(baseUrl), maxAge: 0 });
}
