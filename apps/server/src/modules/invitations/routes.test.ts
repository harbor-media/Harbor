import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../../test-helpers.js";
import { API_PREFIX } from "@harbor/shared";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

function sessionFor(role: "owner" | "administrator" | "user") {
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

async function appWithInvitations() {
  // invitationsRoutes is already registered by createApp (see app.ts), so the
  // real app built by buildTestApp is used directly rather than registering
  // the module a second time (which would collide on route declaration).
  const app = await buildTestApp({ ready: true });
  await app.ready();
  return app;
}

describe("invitation routes authorization", () => {
  it("a user-role session gets 403 on create, list, and revoke", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithInvitations();
    const create = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/invitations`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
      payload: { role: "user" },
    });
    expect(create.statusCode).toBe(403);
    const list = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/invitations`,
      cookies: { harbor_session: "t" },
    });
    expect(list.statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: `${API_PREFIX}/invitations/11111111-1111-1111-1111-111111111111`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
    });
    expect(del.statusCode).toBe(403);
    await app.close();
  });
});

describe("the granting rule", () => {
  it("an administrator cannot create an administrator invite (403 FORBIDDEN)", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("administrator"));
    const app = await appWithInvitations();
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/invitations`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
      payload: { role: "administrator" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    await app.close();
  });

  it("rejects an 'owner' invite at the schema (400 VALIDATION_FAILED)", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("owner"));
    const app = await appWithInvitations();
    const res = await app.inject({
      method: "POST",
      url: `${API_PREFIX}/invitations`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    await app.close();
  });
});
