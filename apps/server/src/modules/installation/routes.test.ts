import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, isSetupComplete: vi.fn() };
});

const { isSetupComplete } = await import("@harbor/database");

describe("GET /api/v1/installation/state", () => {
  it("reports incomplete setup on a fresh install", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setupComplete: false });
    await app.close();
  });

  it("reports complete setup once configured", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.json()).toMatchObject({ setupComplete: true });
    await app.close();
  });

  it("exposes only setupComplete and version", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(Object.keys(res.json() as object).sort()).toEqual(["setupComplete", "version"]);
    await app.close();
  });
});
