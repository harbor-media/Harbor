import { API_PREFIX } from "@harbor/shared";
import { createLogger } from "@harbor/logger";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import type * as DiscoverModule from "./discover.js";
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
    getMetadataProviderConfig: vi.fn().mockResolvedValue(null),
  };
});

// The route's job is auth, validation, delegation, and error mapping -- not
// the fetch logic, which discover.test.ts covers against a real database. So
// fetchGenres/fetchDiscover are mocked and driven per test. The real
// DiscoverUnsupportedError class is preserved, because toHarborError matches
// it with instanceof and a mocked class would never match.
vi.mock("./discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DiscoverModule>();
  return {
    ...actual,
    fetchGenres: vi.fn(),
    fetchDiscover: vi.fn(),
  };
});

const { findSessionByTokenHash } = await import("@harbor/database");
const { fetchGenres, fetchDiscover, DiscoverUnsupportedError } = await import("./discover.js");

const USER_TOKEN = "user-session-token";

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
const signedInGet = (url: string) =>
  app.inject({ method: "GET", url: `${API_PREFIX}${url}`, cookies: signedIn });

describe("discover route authorization", () => {
  it("requires authentication for genres", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/genres/movie` });
    expect(res.statusCode).toBe(401);
    expect(vi.mocked(fetchGenres)).not.toHaveBeenCalled();
  });

  it("requires authentication for discover", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/discover/movie/878` });
    expect(res.statusCode).toBe(401);
    expect(vi.mocked(fetchDiscover)).not.toHaveBeenCalled();
  });
});

describe("discover route validation", () => {
  it("rejects an unknown type with 400", async () => {
    const res = await signedInGet("/genres/music");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a non-numeric genre id with 400", async () => {
    const res = await signedInGet("/discover/movie/notanumber");
    expect(res.statusCode).toBe(400);
  });

  it("rejects a page below 1 with 400", async () => {
    const res = await signedInGet("/discover/movie/878?page=0");
    expect(res.statusCode).toBe(400);
  });
});

describe("discover route delegation and error mapping", () => {
  it("returns genres for a supported type", async () => {
    vi.mocked(fetchGenres).mockResolvedValueOnce({
      type: "movie",
      genres: [{ id: "28", name: "Action" }],
      cached: false,
    });
    const res = await signedInGet("/genres/movie");
    expect(res.statusCode).toBe(200);
    expect(res.json().genres[0].name).toBe("Action");
  });

  it("maps DiscoverUnsupportedError to 409 DISCOVER_UNSUPPORTED", async () => {
    vi.mocked(fetchGenres).mockRejectedValueOnce(new DiscoverUnsupportedError("nope"));
    const res = await signedInGet("/genres/movie");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DISCOVER_UNSUPPORTED");
  });
});
