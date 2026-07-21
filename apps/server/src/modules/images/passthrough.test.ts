import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  return { ...actual, findSessionByTokenHash: vi.fn(), touchSession: vi.fn() };
});
const { findSessionByTokenHash } = await import("@harbor/database");

let app: HarborApp;

beforeAll(async () => {
  // Cache root is a FILE, so every cache write fails and the route must fall
  // back to streaming the image straight through.
  const dir = await mkdtemp(path.join(tmpdir(), "harbor-pt-"));
  const blocker = path.join(dir, "blocked");
  await writeFile(blocker, "");

  vi.mocked(findSessionByTokenHash).mockResolvedValue({
    session: { id: "s", userId: "u", tokenHash: "h", createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
    user: { id: "u", username: "v", email: "v@e.com", role: "user", passwordHash: "x", passwordChangedAt: new Date(Date.now()-60000), failedLoginCount: 0, lastFailedLoginAt: null, createdAt: new Date(), updatedAt: new Date() },
  } as never);

  const state = createRuntimeState();
  state.databaseReady = true; state.migrationsApplied = true; state.dataDirectoryWritable = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("REALIMAGEBYTES", { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;
  void originalFetch;

  app = await createApp({
    env: { ...testEnv, HARBOR_DATA_DIRECTORY: blocker },
    logger: createLogger({ level: "silent", production: true }),
    db: {} as HarborDatabase.Db, sql: createFakeSql().sql, state,
  });
});

/**
 * Regression guard for a real defect: the service returned an async generator
 * and the route sent it straight to Fastify, which only recognizes objects
 * with .pipe as streams. Every degraded response was a 500 instead of an
 * image, so the documented "a full disk does not take artwork offline"
 * behavior did not work at all. The service-level test could not catch it --
 * it stopped at the service boundary.
 */
describe("degraded pass-through through the route", () => {
  it("streams the real image bytes when the cache cannot be written", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${API_PREFIX}/images/tmdb/w342/abc.jpg`,
      cookies: { [SESSION_COOKIE]: "t" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString("utf8")).toBe("REALIMAGEBYTES");
  });
});
