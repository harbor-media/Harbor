import { describe, expect, it } from "vitest";
import { loadEnv } from "./index.js";

const valid = {
  DATABASE_URL: "postgresql://harbor:pw@localhost:5432/harbor",
  HARBOR_BASE_URL: "https://harbor.example.com",
  HARBOR_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv({ ...valid } as NodeJS.ProcessEnv);
    expect(env.HARBOR_PORT).toBe(3000);
    expect(env.HARBOR_DATA_DIRECTORY).toBe("/data");
    expect(env.HARBOR_LOG_LEVEL).toBe("info");
    expect(env.HARBOR_TRUST_PROXY).toBe(false);
    expect(env.NODE_ENV).toBe("development");
    expect(env.HARBOR_RATE_LIMIT_MAX).toBe(100);
  });

  it("coerces a configured rate-limit ceiling to a number", () => {
    const env = loadEnv({ ...valid, HARBOR_RATE_LIMIT_MAX: "5000" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_RATE_LIMIT_MAX).toBe(5000);
  });

  it("coerces the port to a number", () => {
    const env = loadEnv({ ...valid, HARBOR_PORT: "8080" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_PORT).toBe(8080);
  });

  it('parses the string "false" as boolean false', () => {
    const env = loadEnv({ ...valid, HARBOR_TRUST_PROXY: "false" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_TRUST_PROXY).toBe(false);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(() => loadEnv({ ...valid, HARBOR_SECRET: "tooshort" } as NodeJS.ProcessEnv)).toThrow(
      /HARBOR_SECRET/,
    );
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() =>
      loadEnv({ ...valid, DATABASE_URL: "mysql://localhost/harbor" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects an unknown log level", () => {
    expect(() =>
      loadEnv({ ...valid, HARBOR_LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv),
    ).toThrow(/HARBOR_LOG_LEVEL/);
  });

  it("rejects a non-http(s) HARBOR_BASE_URL", () => {
    expect(() =>
      loadEnv({ ...valid, HARBOR_BASE_URL: "ftp://example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/HARBOR_BASE_URL/);
  });

  it("accepts an http HARBOR_BASE_URL", () => {
    const env = loadEnv({ ...valid, HARBOR_BASE_URL: "http://localhost:3000" } as NodeJS.ProcessEnv);
    expect(env.HARBOR_BASE_URL).toBe("http://localhost:3000");
  });
});
