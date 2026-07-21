import type { Db } from "@harbor/database";
import { createLogger } from "@harbor/logger";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createFakeSql, testEnv } from "./test-helpers.js";
import { createRuntimeState } from "./state.js";

// Harbor runs with `disableRequestLogging: false`, so Fastify emits an
// "incoming request" / "request completed" pair carrying `req.url` for every
// request. The public invite-inspection route is the one place in Harbor
// where a bearer secret travels in a URL path instead of a request body, so
// this asserts the end-to-end wiring: that the logger's `req` serializer
// survives Fastify's own serializer merge under `loggerInstance` and actually
// masks the token before it reaches an access log. A unit test of the
// masking function alone cannot prove that — the serializer could be silently
// overridden by Fastify's default and the regex would still pass its tests.
describe("request-log redaction", () => {
  async function captureRequestLogs(url: string): Promise<string> {
    const lines: string[] = [];
    const app = await createApp({
      env: testEnv,
      logger: createLogger(
        { level: "info", production: true },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      ),
      db: {} as Db,
      sql: createFakeSql().sql,
      state: createRuntimeState(),
    });

    await app.inject({ method: "GET", url });
    await app.close();

    return lines.join("\n");
  }

  it("never writes the raw invite token to the request log", async () => {
    const token = "Xh2n4Kq8vTdR7bLpZ0aJmWcF3sYuE1gN6oQiP5rtBkA";

    const logs = await captureRequestLogs(`/api/v1/invitations/${token}`);

    // Sanity: the route was reached and logged at all, so a passing
    // assertion below reflects redaction rather than an empty capture.
    expect(logs).toContain("/api/v1/invitations/");
    expect(logs).not.toContain(token);
    expect(logs).toContain("/api/v1/invitations/[redacted]");
  });

  it("still logs unrelated URLs in full", async () => {
    const logs = await captureRequestLogs("/api/v1/health");

    expect(logs).toContain("/api/v1/health");
    expect(logs).not.toContain("[redacted]");
  });
});
