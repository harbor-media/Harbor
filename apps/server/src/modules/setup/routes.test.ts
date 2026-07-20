import { randomUUID } from "node:crypto";
import type * as HarborDatabase from "@harbor/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    completeSetupWithOwner: vi.fn(),
    createSession: vi.fn(),
  };
});

const { completeSetupWithOwner, createSession, SetupAlreadyCompleteError } =
  await import("@harbor/database");

const VALID_BODY = {
  language: "en",
  serverName: "Test Server",
  username: "owner",
  email: "owner@example.com",
  password: "correct-horse-battery",
};

function makeOwner() {
  const now = new Date();
  return {
    id: randomUUID(),
    username: "owner",
    email: "owner@example.com",
    passwordHash: "$argon2id$fake$hash",
    role: "owner" as const,
    createdAt: now,
    updatedAt: now,
  };
}

describe("POST /api/v1/setup", () => {
  beforeEach(() => {
    vi.mocked(completeSetupWithOwner).mockReset();
    vi.mocked(createSession).mockReset();
  });

  it("creates the owner on a fresh install and sets a session cookie", async () => {
    const owner = makeOwner();
    vi.mocked(completeSetupWithOwner).mockResolvedValue(owner);
    vi.mocked(createSession).mockResolvedValue({
      id: randomUUID(),
      userId: owner.id,
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 1000),
      createdAt: new Date(),
      lastSeenAt: new Date(),
      userAgent: null,
      ip: null,
    });

    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: "http://localhost:3000" },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    const raw = res.body;
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("argon2");

    const json = res.json() as { user: { id: string; username: string } };
    expect(json.user).toMatchObject({ id: owner.id, username: "owner" });

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie);
    expect(cookieStr).toContain("harbor_session=");
    expect(cookieStr.toLowerCase()).toContain("httponly");

    await app.close();
  });

  it("returns 409 SETUP_ALREADY_COMPLETE when setup has already run", async () => {
    vi.mocked(completeSetupWithOwner).mockRejectedValue(new SetupAlreadyCompleteError());

    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: "http://localhost:3000" },
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "SETUP_ALREADY_COMPLETE" } });

    await app.close();
  });

  it("rejects a username containing @ with 400 VALIDATION_FAILED and creates no user", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: "http://localhost:3000" },
      payload: { ...VALID_BODY, username: "victim@example.com" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(completeSetupWithOwner).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects a short password with 400 and creates no user", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: { origin: "http://localhost:3000" },
      payload: { ...VALID_BODY, password: "short1" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(completeSetupWithOwner).not.toHaveBeenCalled();

    await app.close();
  });
});
