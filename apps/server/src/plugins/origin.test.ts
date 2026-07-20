import type * as HarborDatabase from "@harbor/database";
import { describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const SESSION_USER = {
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

// testEnv sets HARBOR_BASE_URL to http://localhost:3000
async function build() {
  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: SESSION_USER.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
      createdAt: new Date(),
    },
    user: SESSION_USER,
  });
  const app = await buildTestApp({ ready: true });
  app.post("/api/v1/mutating-probe", async () => ({ ok: true }));
  await app.ready();
  return app;
}

const COOKIES = { harbor_session: "token" };

describe("origin check", () => {
  it("allows a same-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a cross-origin mutating request", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a lookalike origin that a naive prefix match would allow", async () => {
    // "http://localhost:3000@evil.example.com" is a valid URL whose string
    // form starts with the exact expected origin ("http://localhost:3000"),
    // via userinfo syntax — a naive `startsWith`/`includes` check on the raw
    // header would let it through. `new URL(...).origin` correctly resolves
    // it to "http://evil.example.com", so a parsed-origin comparison rejects
    // it. This is the single most important test in this suite.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "http://localhost:3000@evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows a request with no Origin (non-browser client)", async () => {
    // A browser always sends Origin on a cross-site POST, so its absence means
    // a non-browser caller, which carries no ambient cookies and so no CSRF risk.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a literal Origin: null", async () => {
    // Sandboxed iframes and some redirect chains send the literal string
    // "null" as Origin. `new URL("null")` throws, so a naive implementation
    // treats this the same as a missing header (i.e. "non-browser client,
    // allow") — but a literal "null" IS a browser signal and should be an
    // explicit reject, not a free pass.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { origin: "null" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("falls back to Referer when Origin is absent", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/mutating-probe",
      cookies: COOKIES,
      headers: { referer: "https://evil.example.com/page" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("does not check safe methods", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
