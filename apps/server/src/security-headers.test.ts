import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-helpers.js";

describe("security headers", () => {
  it("sets CSP and nosniff on an API response", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    await app.close();
  });

  it("sets CSP and nosniff on the SPA shell fallback response", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/some-deep-link" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    await app.close();
  });
});
