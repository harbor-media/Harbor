import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { API_PREFIX } from "@harbor/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { createApp, type HarborApp } from "../../app.js";
import { createRuntimeState } from "../../state.js";
import { createFakeSql, testEnv } from "../../test-helpers.js";
import { createLogger } from "@harbor/logger";
import { SESSION_COOKIE } from "../auth/cookies.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});

const { findSessionByTokenHash } = await import("@harbor/database");

const USER_TOKEN = "user-session-token";

function signedInUser(): void {
  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: {
      id: "22222222-2222-2222-2222-222222222222",
      userId: "11111111-1111-1111-1111-111111111111",
      tokenHash: "hash",
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
    user: {
      id: "11111111-1111-1111-1111-111111111111",
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
}

let app: HarborApp;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "harbor-image-routes-"));

  // Pre-populate the cache so the happy path needs no network at all.
  const cached = path.join(dataDirectory, "cache", "images", "tmdb", "w342");
  await mkdir(cached, { recursive: true });
  await writeFile(path.join(cached, "cached.jpg"), Buffer.from("jpegbytes"));

  const state = createRuntimeState();
  state.databaseReady = true;
  state.migrationsApplied = true;
  state.dataDirectoryWritable = true;

  app = await createApp({
    env: { ...testEnv, HARBOR_DATA_DIRECTORY: dataDirectory },
    logger: createLogger({ level: "silent", production: true }),
    db: {} as HarborDatabase.Db,
    sql: createFakeSql().sql,
    state,
  });
});

const url = (file: string, size = "w342", provider = "tmdb"): string =>
  `${API_PREFIX}/images/${provider}/${size}/${file}`;

describe("image routes", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: url("cached.jpg") });
    expect(res.statusCode).toBe(401);
  });

  it("serves a cached image to a signed-in user", async () => {
    signedInUser();
    const res = await app.inject({
      method: "GET",
      url: url("cached.jpg"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.rawPayload.toString("utf8")).toBe("jpegbytes");
  });

  it("sets nosniff and a private cache-control", async () => {
    signedInUser();
    const res = await app.inject({
      method: "GET",
      url: url("cached.jpg"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });

    // nosniff stops a browser re-interpreting the body as something
    // executable; private stops an intermediary sharing it between users.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["cache-control"])).toContain("private");
  });

  it("returns 304 when the etag matches", async () => {
    signedInUser();
    const first = await app.inject({
      method: "GET",
      url: url("cached.jpg"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    const etag = String(first.headers["etag"]);

    const second = await app.inject({
      method: "GET",
      url: url("cached.jpg"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
      headers: { "if-none-match": etag },
    });

    expect(second.statusCode).toBe(304);
  });

  it("rejects an unknown provider", async () => {
    signedInUser();
    const res = await app.inject({
      method: "GET",
      url: url("cached.jpg", "w342", "evil"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unsupported size", async () => {
    signedInUser();
    const res = await app.inject({
      method: "GET",
      url: url("cached.jpg", "w9999"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });

  // Traversal must be refused rather than resolved. A 200 here would mean the
  // proxy could read arbitrary files off the server's disk.
  it.each(["..%2f..%2fetc%2fpasswd", "..%2fsecret.jpg", "%2e%2e%2fsecret.jpg"])(
    "rejects traversal attempt %s",
    async (file) => {
      signedInUser();
      const res = await app.inject({
        method: "GET",
        url: url(file),
        cookies: { [SESSION_COOKIE]: USER_TOKEN },
      });
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBeLessThan(500);
    },
  );

  it("rejects an svg filename", async () => {
    signedInUser();
    const res = await app.inject({
      method: "GET",
      url: url("payload.svg"),
      cookies: { [SESSION_COOKIE]: USER_TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });
});
