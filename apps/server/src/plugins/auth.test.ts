import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp, createFakeSql } from "../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const VALID_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "owner",
  email: "owner@example.com",
  role: "owner" as const,
  passwordHash: "x",
  passwordChangedAt: new Date(),
  failedLoginCount: 0,
  lastFailedLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function validSession() {
  return {
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: VALID_USER.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user: VALID_USER,
  };
}

describe("auth guard", () => {
  it("allows every allowlisted public route without a session", async () => {
    const app = await buildTestApp({ ready: true });
    for (const url of [
      "/api/v1/health",
      "/api/v1/health/live",
      "/api/v1/health/ready",
      "/api/v1/installation/state",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} should be public`).not.toBe(401);
    }
    await app.close();
  });

  it("FAILS CLOSED: a route registered without allowlisting requires a session", async () => {
    // The whole design rests on this. A new route is protected by default;
    // nobody has to remember to add a guard.
    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/brand-new-route", async () => ({ secret: "value" }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/v1/brand-new-route" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(res.body).not.toContain("value");
    await app.close();
  });

  it("rejects a request whose cookie matches no session", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(null);
    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an expired session and does not leak the user", async () => {
    const expired = validSession();
    expired.session.expiresAt = new Date(Date.now() - 1000);
    vi.mocked(findSessionByTokenHash).mockResolvedValue(expired);

    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async (request) => ({ user: request.user }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("owner");
    await app.close();
  });

  it("admits a valid session and decorates request.user", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(validSession());

    const app = await buildTestApp({ ready: true });
    app.get("/api/v1/guarded", async (request) => ({ user: request.user }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      user: { username: "owner", role: "owner", email: "owner@example.com" },
    });
    // request.user must never carry the hash.
    expect(res.body).not.toContain("passwordHash");
    await app.close();
  });

  it("leaves non-API paths public so the SPA shell can load", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(res.statusCode).not.toBe(401);
    await app.close();
  });

  it("yields 503, not 500, when Harbor is not ready and a cookie is present", async () => {
    // The guard runs at root, ahead of the API scope's readiness gate. Without
    // its own readiness check it would query a database that may be down and
    // surface INTERNAL_ERROR, breaking the Phase 1 contract that non-health API
    // routes answer 503 SERVICE_UNAVAILABLE while starting up.
    vi.mocked(findSessionByTokenHash).mockClear();
    const app = await buildTestApp({ ready: false });
    app.get("/api/v1/guarded", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(findSessionByTokenHash).not.toHaveBeenCalled();
    await app.close();
  });

  it("yields 503, not 500, when the database goes down AFTER boot (stale cached readiness)", async () => {
    // Distinct from the cold-start case above: here `state.databaseReady` was
    // set true at boot, exactly as it would be if Postgres restarts sometime
    // after a successful startup. The API-scope readiness hook that would
    // normally catch this runs AFTER the guard's root-level onRequest hook, so
    // without its own live probe the guard would trust the stale flag, reach
    // `findSessionByTokenHash`, hit a dead connection, and surface a raw 500 —
    // breaking the Phase 1 contract that non-health API routes answer 503
    // while Harbor cannot serve requests. `service-unavailable.test.ts` only
    // covers the cold-start path on a PUBLIC route; this is the guarded-route,
    // post-boot-outage case.
    vi.mocked(findSessionByTokenHash).mockClear();
    const failing = createFakeSql(true); // every probe query rejects
    const app = await buildTestApp({ ready: true, sql: failing.sql });
    app.get("/api/v1/guarded", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/guarded",
      cookies: { harbor_session: "token" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(findSessionByTokenHash).not.toHaveBeenCalled();
    await app.close();
  });
});
