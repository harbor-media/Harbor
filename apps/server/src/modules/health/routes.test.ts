import { describe, expect, it } from "vitest";
import { buildTestApp } from "../../test-helpers.js";

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
});
