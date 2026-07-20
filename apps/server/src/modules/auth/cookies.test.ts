import cookiePlugin from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TTL_MS } from "./tokens.js";
import { SESSION_COOKIE, clearSessionCookie, cookieOptions, setSessionCookie } from "./cookies.js";

describe("cookieOptions", () => {
  it("marks Secure for an https base URL", () => {
    expect(cookieOptions("https://harbor.example.com").secure).toBe(true);
  });

  it("does NOT mark Secure for plain http", () => {
    // Hardcoding Secure=true breaks local development: the browser silently
    // drops the cookie and login appears to succeed while nothing persists.
    expect(cookieOptions("http://localhost:5173").secure).toBe(false);
  });

  it("always sets HttpOnly, SameSite=Lax and root path", () => {
    const o = cookieOptions("https://harbor.example.com");
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
  });

  it("expires in step with the session TTL", () => {
    expect(cookieOptions("https://harbor.example.com").maxAge).toBe(SESSION_TTL_MS / 1000);
  });
});

// These tests build a minimal Fastify instance with the real @fastify/cookie
// plugin registered, rather than passing options objects around, so they
// prove what actually lands on the wire in the `Set-Cookie` header — not
// merely what was passed into `reply.setCookie`.
describe("setSessionCookie / clearSessionCookie (real Set-Cookie header)", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function buildCookieTestApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    await app.register(cookiePlugin);
    app.get("/set-http", (_req, reply) => {
      setSessionCookie(reply, "raw-token-value", "http://localhost:5173");
      reply.send({ ok: true });
    });
    app.get("/set-https", (_req, reply) => {
      setSessionCookie(reply, "raw-token-value", "https://harbor.example.com");
      reply.send({ ok: true });
    });
    app.get("/clear", (_req, reply) => {
      clearSessionCookie(reply, "https://harbor.example.com");
      reply.send({ ok: true });
    });
    apps.push(app);
    return app;
  }

  it("emits a Set-Cookie header with HttpOnly, SameSite=Lax, Path=/, and Secure for https", async () => {
    const app = await buildCookieTestApp();
    const res = await app.inject({ method: "GET", url: "/set-https" });
    const header = res.headers["set-cookie"];
    expect(header).toBeDefined();
    const cookie = Array.isArray(header) ? header[0] : header;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Secure/i);
  });

  it("omits Secure from the Set-Cookie header for http", async () => {
    const app = await buildCookieTestApp();
    const res = await app.inject({ method: "GET", url: "/set-http" });
    const header = res.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    expect(cookie).toBeDefined();
    expect(cookie).not.toMatch(/Secure/i);
    // Still HttpOnly/SameSite/Path even without Secure.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it("carries the raw token value and nothing else identifying the user", async () => {
    const app = await buildCookieTestApp();
    const res = await app.inject({ method: "GET", url: "/set-https" });
    const header = res.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    expect(cookie).toBeDefined();
    expect(cookie).toContain("raw-token-value");
    // No user id, role, or hash-shaped hex string beyond the token itself.
    expect(cookie).not.toMatch(/role/i);
    expect(cookie).not.toMatch(/userId/i);
    expect(cookie).not.toMatch(/admin|owner/i);
  });

  it("clearSessionCookie expires the cookie with the same Path used to set it", async () => {
    const app = await buildCookieTestApp();
    const res = await app.inject({ method: "GET", url: "/clear" });
    const header = res.headers["set-cookie"];
    const cookie = Array.isArray(header) ? header[0] : header;
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/Expires=/i);
    const expiresMatch = /Expires=([^;]+)/i.exec(cookie ?? "");
    expect(expiresMatch).not.toBeNull();
    const expiresDate = new Date(expiresMatch?.[1] ?? "");
    expect(expiresDate.getTime()).toBeLessThan(Date.now());
  });
});
