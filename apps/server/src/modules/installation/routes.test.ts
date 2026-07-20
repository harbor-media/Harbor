import { describe, expect, it, vi } from "vitest";
import type * as HarborDatabase from "@harbor/database";
import { buildTestApp } from "../../test-helpers.js";

vi.mock("@harbor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof HarborDatabase>();
  return { ...actual, isSetupComplete: vi.fn(), getRegistrationMode: vi.fn() };
});

const { isSetupComplete, getRegistrationMode } = await import("@harbor/database");

describe("GET /api/v1/installation/state", () => {
  it("reports incomplete setup on a fresh install", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    vi.mocked(getRegistrationMode).mockResolvedValue("invitation-only");
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ setupComplete: false });
    await app.close();
  });

  it("reports complete setup once configured", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    vi.mocked(getRegistrationMode).mockResolvedValue("invitation-only");
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.json()).toMatchObject({ setupComplete: true });
    await app.close();
  });

  it("reports the current registration mode", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    vi.mocked(getRegistrationMode).mockResolvedValue("open");
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(res.json()).toMatchObject({ registrationMode: "open" });
    await app.close();
  });

  it("exposes only setupComplete, version and registrationMode", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    vi.mocked(getRegistrationMode).mockResolvedValue("invitation-only");
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/installation/state" });
    expect(Object.keys(res.json() as object).sort()).toEqual([
      "registrationMode",
      "setupComplete",
      "version",
    ]);
    await app.close();
  });
});
