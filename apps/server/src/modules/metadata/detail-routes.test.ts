import { API_PREFIX } from "@harbor/shared";
import { createLogger } from "@harbor/logger";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { createApp, type HarborApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import { createFakeSql, testEnv } from "../../test-helpers.js";
import { SESSION_COOKIE } from "../auth/cookies.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return {
    ...actual,
    findSessionByTokenHash: vi.fn(),
    touchSession: vi.fn(),
    // No provider configured: these tests exercise auth and validation, which
    // must be decided before anything reaches the metadata layer.
    getMetadataProviderConfig: vi.fn().mockResolvedValue(null),
    getTitleDetail: vi.fn().mockResolvedValue(null),
  };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const USER_TOKEN = "user-session-token";
// A real v4 UUID. z.uuid() enforces the RFC 4122 variant nibble, so a
// pattern like 1111-1111-... is rejected as malformed before it ever reaches
// the service -- which is correct, since Harbor ids come from
// gen_random_uuid() and are always well formed.
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let app: HarborApp;

beforeAll(async () => {
  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      tokenHash: "hash",
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
    user: {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      username: "viewer",
      email: "viewer@example.com",
      role: "user",
      passwordHash: "x",
      passwordChangedAt: new Date(Date.now() - 60_000),
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Awaited<ReturnType<typeof findSessionByTokenHash>>);

  const state = createRuntimeState();
  state.databaseReady = true;
  state.migrationsApplied = true;
  state.dataDirectoryWritable = true;

  app = await createApp({
    env: testEnv,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as HarborDatabase.Db,
    sql: createFakeSql().sql,
    state,
  });
});

const signedIn = { [SESSION_COOKIE]: USER_TOKEN };

describe("detail route authorization", () => {
  it("refuses an anonymous title request", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/titles/${UUID}` });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an anonymous season request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/1`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("detail route validation", () => {
  it("rejects a non-uuid title id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/not-a-uuid`,
      cookies: signedIn,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a negative season number", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/-1`,
      cookies: signedIn,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric season", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/abc`,
      cookies: signedIn,
    });
    expect(res.statusCode).toBe(400);
  });

  // Season 0 is the specials season and is a real, requestable season.
  it("accepts season zero as a valid number", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/0`,
      cookies: signedIn,
    });
    expect(res.statusCode).not.toBe(400);
  });
});

describe("detail route error mapping", () => {
  // An unknown title is the client's problem, not the provider's. Returning
  // a server error here would send an operator looking at TMDB.
  it("maps an unknown title to 404, never 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}`,
      cookies: signedIn,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("maps an unknown season to 404, never 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/titles/${UUID}/seasons/1`,
      cookies: signedIn,
    });

    expect(res.statusCode).toBe(404);
  });
});
