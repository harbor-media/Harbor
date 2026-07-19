import type { HarborEnv } from "@harbor/config";
import type { Db } from "@harbor/database";
import { createLogger } from "@harbor/logger";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createRuntimeState } from "../state.js";
import { HarborError } from "./errors.js";

const TEST_ENV: HarborEnv = {
  NODE_ENV: "test",
  HARBOR_PORT: 3000,
  HARBOR_HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://harbor:harbor@localhost:5432/harbor",
  HARBOR_BASE_URL: "http://localhost:3000",
  HARBOR_SECRET: "a".repeat(32),
  HARBOR_DATA_DIRECTORY: "/data",
  HARBOR_LOG_LEVEL: "fatal",
  HARBOR_TRUST_PROXY: false,
};

async function buildApp() {
  const app = await createApp({
    env: TEST_ENV,
    logger: createLogger({ level: "silent", production: true }),
    db: {} as Db,
    state: createRuntimeState(),
  });

  app.get("/__test/harbor-error", () => {
    throw new HarborError("SETUP_ALREADY_COMPLETE", "Setup has already been completed.", 409);
  });

  app.get("/__test/plain-error", () => {
    throw new Error("secret filesystem detail /home/harbor/.env");
  });

  app.get("/__test/not-found-error", () => {
    const err = new Error("secret filesystem detail /home/harbor/.env") as Error & {
      statusCode?: number;
    };
    err.statusCode = 404;
    throw err;
  });

  app.get("/__test/rate-limited-error", () => {
    const err = new Error("secret internal rate limiter detail") as Error & {
      statusCode?: number;
    };
    err.statusCode = 429;
    throw err;
  });

  await app.ready();
  return app;
}

describe("errors plugin", () => {
  it("HarborError returns its own code, status, and message", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/__test/harbor-error" });
    expect(res.statusCode).toBe(409);
    const json = res.json();
    expect(json.error.code).toBe("SETUP_ALREADY_COMPLETE");
    expect(json.error.message).toBe("Setup has already been completed.");
    expect(typeof json.error.requestId).toBe("string");
    await app.close();
  });

  it("plain Error returns 500 INTERNAL_ERROR without leaking message or stack", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/__test/plain-error" });
    expect(res.statusCode).toBe(500);
    const json = res.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(res.body).not.toContain("secret filesystem detail");
    expect(res.body).not.toContain("/home/harbor/.env");
    expect(res.body.toLowerCase()).not.toContain("at ");
    expect(typeof json.error.requestId).toBe("string");
    await app.close();
  });

  it("statusCode 404 error returns NOT_FOUND without leaking the original message", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/__test/not-found-error" });
    expect(res.statusCode).toBe(404);
    const json = res.json();
    expect(json.error.code).toBe("NOT_FOUND");
    expect(res.body).not.toContain("secret filesystem detail");
    expect(typeof json.error.requestId).toBe("string");
    await app.close();
  });

  it("statusCode 429 error returns RATE_LIMITED", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/__test/rate-limited-error" });
    expect(res.statusCode).toBe(429);
    const json = res.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(res.body).not.toContain("secret internal rate limiter detail");
    expect(typeof json.error.requestId).toBe("string");
    await app.close();
  });
});
