import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../../test-helpers.js";
import { API_PREFIX } from "@harbor/shared";
import { SESSION_COOKIE } from "../auth/cookies.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    findSessionByTokenHash: vi.fn(),
    touchSession: vi.fn(),
    getMetadataProviderConfig: vi.fn().mockResolvedValue(null),
  };
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

// metadataRoutes is already registered by createApp (see app.ts), so the real
// app built by buildTestApp is used directly rather than registering the
// module a second time (which would collide on route declaration).
async function appWithMetadata() {
  return buildTestApp({ ready: true });
}

const userToken = "user-token";

describe("metadata routes authorization", () => {
  it("rejects an anonymous request for the config", async () => {
    const app = await appWithMetadata();
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/admin/metadata/config` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a plain user reading the config", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithMetadata();
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/admin/metadata/config`,
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a plain user writing the config", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithMetadata();
    const res = await app.inject({
      method: "PUT",
      url: `${API_PREFIX}/admin/metadata/config`,
      cookies: { [SESSION_COOKIE]: userToken },
      headers: { origin: "http://localhost:3000" },
      payload: { apiKey: "x", language: "en-US", enabled: true },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an anonymous search", async () => {
    const app = await appWithMetadata();
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/search?q=blade` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("reports an unconfigured provider distinctly, not as a server error", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithMetadata();
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/search?q=blade`,
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("METADATA_NOT_CONFIGURED");
    await app.close();
  });

  it("rejects an empty search query", async () => {
    vi.mocked(findSessionByTokenHash).mockResolvedValue(sessionFor("user"));
    const app = await appWithMetadata();
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/search?q=`,
      cookies: { [SESSION_COOKIE]: userToken },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
