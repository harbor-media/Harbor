import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestApp, createFakeSql } from "../../test-helpers.js";

describe("health endpoints", () => {
  it("reports live regardless of dependency state", async () => {
    const app = await buildTestApp({ ready: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("reports not ready before boot completes", async () => {
    const app = await buildTestApp({ ready: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ready: false,
      checks: { database: false, migrations: false, dataDirectory: false },
    });
    await app.close();
  });

  it("reports ready once every check passes", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
    await app.close();
  });

  it("always returns 200 from the summary endpoint", async () => {
    const app = await buildTestApp({ ready: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const bodyJson = res.json() as { status: string; version: string; uptimeSeconds: number };
    expect(bodyJson.status).toBe("degraded");
    expect(typeof bodyJson.version).toBe("string");
    expect(bodyJson.uptimeSeconds).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it("returns a JSON error envelope for unknown API routes", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    await app.close();
  });

  it("returns a JSON 404 for unknown API routes even with the SPA fallback active", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    await app.close();
  });

  describe("live database readiness probe", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns 200 when the live database probe succeeds", async () => {
      const fake = createFakeSql(false);
      const app = await buildTestApp({ ready: true, sql: fake.sql });
      const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ready: true, checks: { database: true } });
      await app.close();
    });

    it("returns 503 when the probe throws, even though migrations were applied at boot", async () => {
      const fake = createFakeSql(true);
      const app = await buildTestApp({ ready: true, sql: fake.sql });
      const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        ready: false,
        checks: { database: false, migrations: true, dataDirectory: true },
      });
      await app.close();
    });

    it("caches the probe result so rapid successive requests issue only one database query", async () => {
      const fake = createFakeSql(false);
      const app = await buildTestApp({ ready: true, sql: fake.sql });

      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const first = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(first.statusCode).toBe(200);
      expect(fake.queryCount()).toBe(1);

      now += 100; // well within the TTL
      const second = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(second.statusCode).toBe(200);
      expect(fake.queryCount()).toBe(1);

      await app.close();
    });

    it("probes again once the cache TTL elapses", async () => {
      const fake = createFakeSql(false);
      const app = await buildTestApp({ ready: true, sql: fake.sql });

      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(fake.queryCount()).toBe(1);

      now += 5_001; // past the TTL
      await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(fake.queryCount()).toBe(2);

      await app.close();
    });

    it("keeps liveness returning 200 while the database probe is failing", async () => {
      const fake = createFakeSql(true);
      const app = await buildTestApp({ ready: true, sql: fake.sql });

      await app.inject({ method: "GET", url: "/api/v1/health/ready" });

      const res = await app.inject({ method: "GET", url: "/api/v1/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok" });
      await app.close();
    });
  });
});
