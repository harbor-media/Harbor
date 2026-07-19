import type * as HarborDatabase from "@harbor/database";
import { describe, expect, it, vi } from "vitest";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, isSetupComplete: vi.fn().mockResolvedValue(false) };
});

const { buildTestApp } = await import("./test-helpers.js");

describe("not-ready request gate", () => {
  it("returns 503 SERVICE_UNAVAILABLE from a non-health API route while not ready", async () => {
    const app = await buildTestApp({ ready: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    await app.close();
  });

  it("keeps /health and /health/live reachable and returning 200 while not ready", async () => {
    const app = await buildTestApp({ ready: false });
    for (const path of ["/api/v1/health", "/api/v1/health/live"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("keeps /health/ready reachable while not ready, answering with its own payload rather than the gate's 503 envelope", async () => {
    const app = await buildTestApp({ ready: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false });
    await app.close();
  });

  it("serves a normal API route once the app is ready", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setupComplete: false });
    await app.close();
  });
});
