import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../test-helpers.js";
import { requireRole } from "./require-role.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

function sessionFor(role: "owner" | "administrator" | "user" | "guest") {
  const user = {
    id: "11111111-1111-1111-1111-111111111111",
    username: role,
    email: `${role}@example.com`,
    role,
    passwordHash: "x",
    passwordChangedAt: new Date(),
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: user.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user,
  };
}

async function appWithGuardedRoute() {
  const app = await buildTestApp({ ready: true });
  app.get(
    "/api/v1/admin-only",
    { preHandler: [requireRole("administrator")] },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

describe("requireRole", () => {
  it("returns 403 FORBIDDEN for a user-role session (load-bearing: a no-op requireRole would 200 here)", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithGuardedRoute();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin-only",
      cookies: { harbor_session: "t" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(res.body).not.toContain("ok");
    await app.close();
  });

  it("allows an administrator session through to the handler", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("administrator"));
    const app = await appWithGuardedRoute();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin-only",
      cookies: { harbor_session: "t" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("allows an owner (higher rank) through", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("owner"));
    const app = await appWithGuardedRoute();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin-only",
      cookies: { harbor_session: "t" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 401 for an unauthenticated request (auth guard fires first)", async () => {
    const app = await appWithGuardedRoute();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin-only" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
