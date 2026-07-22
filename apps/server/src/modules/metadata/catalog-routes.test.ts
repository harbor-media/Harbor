import { API_PREFIX } from "@harbor/shared";
import { createLogger } from "@harbor/logger";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import type * as CatalogModule from "./catalog.js";
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
// the fetch logic, which catalog.test.ts covers against a real database. So
// fetchCatalogRow is mocked and driven per test. The real
// CatalogKindUnsupportedError class is preserved, because toHarborError
// matches it with instanceof and a mocked class would never match.
vi.mock("./catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return {
    ...actual,
    fetchCatalogRow: vi.fn(),
  };
});

const { findSessionByTokenHash } = await import("@harbor/database");
const { fetchCatalogRow, CatalogKindUnsupportedError } = await import("./catalog.js");

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

describe("catalog route authorization", () => {
  it("refuses an anonymous request", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/catalog/trending` });
    expect(res.statusCode).toBe(401);
    // The handler must never run for an anonymous caller.
    expect(vi.mocked(fetchCatalogRow)).not.toHaveBeenCalled();
  });
});

describe("catalog route validation", () => {
  it("rejects an unknown kind with 400 before reaching the service", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/catalog/not-a-kind`,
      cookies: signedIn,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(vi.mocked(fetchCatalogRow)).not.toHaveBeenCalled();
  });
});

describe("catalog route delegation and error mapping", () => {
  it("returns the row for a supported kind", async () => {
    vi.mocked(fetchCatalogRow).mockResolvedValueOnce({
      kind: "trending",
      titles: [{ id: "id-1", type: "movie", title: "Blade Runner", year: 1982, posterPath: "/p.jpg" }],
      cached: false,
    });

    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/catalog/trending`,
      cookies: signedIn,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("trending");
    expect(Array.isArray(res.json().titles)).toBe(true);
    expect(res.json().titles[0].title).toBe("Blade Runner");
  });

  it("maps CatalogKindUnsupportedError to 409 CATALOG_KIND_UNSUPPORTED", async () => {
    vi.mocked(fetchCatalogRow).mockRejectedValueOnce(
      new CatalogKindUnsupportedError('The configured provider cannot serve "new-releases".'),
    );

    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/catalog/new-releases`,
      cookies: signedIn,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CATALOG_KIND_UNSUPPORTED");
  });
});
