import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../../test-helpers.js";
import { API_PREFIX } from "@harbor/shared";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

function sessionFor(role: "administrator" | "user") {
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

// settingsRoutes is already registered by createApp (see app.ts), so the real
// app built by buildTestApp is used directly rather than registering it again
// — a second registration would collide on the same route path.
async function appWithSettings() {
  return buildTestApp({ ready: true });
}

describe("registration settings authorization", () => {
  it("a user-role session gets 403 on PATCH", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithSettings();
    const res = await app.inject({
      method: "PATCH",
      url: `${API_PREFIX}/settings/registration`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
      payload: { mode: "invitation-only" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("open registration acknowledgement", () => {
  it("refuses to switch to 'open' without acknowledgeOpenRisk (400 naming the risk)", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("administrator"));
    const app = await appWithSettings();
    const res = await app.inject({
      method: "PATCH",
      url: `${API_PREFIX}/settings/registration`,
      cookies: { harbor_session: "t" },
      headers: { origin: "http://localhost:3000" },
      payload: { mode: "open" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(res.json().error.message).toMatch(/without an invitation/i);
    await app.close();
  });
});
