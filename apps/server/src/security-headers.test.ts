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

describe("content security policy asymmetry", () => {
  /**
   * style-src permits inline so Radix can position its floating primitives;
   * script-src must not follow it. These are pinned together so the
   * relaxation cannot spread by symmetry later -- someone reading only
   * style-src could reasonably assume inline is fine generally, and it is
   * script-src that actually stops code execution.
   */
  it("allows inline style but never inline script", async () => {
    const app = await buildTestApp({ ready: true });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    const csp = String(res.headers["content-security-policy"]);

    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");

    await app.close();
  });
});
