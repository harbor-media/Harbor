import { describe, expect, it } from "vitest";
import { createLogger, forRequest } from "./index.js";

function capture(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => { lines.push(s); } } };
}

describe("createLogger redaction", () => {
  it("removes secrets but preserves surrounding fields", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);

    log.info(
      {
        password: "hunter2",
        apiKey: "sk-live-abc123",
        provider: { credentials: { token: "tok-secret" } },
        req: { headers: { authorization: "Bearer xyz", "user-agent": "harbor-test" } },
        titleId: "tt0111161",
      },
      "provider configured",
    );

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;

    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("sk-live-abc123");
    expect(raw).not.toContain("tok-secret");
    expect(raw).not.toContain("Bearer xyz");

    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry["msg"]).toBe("provider configured");
    expect(entry["titleId"]).toBe("tt0111161");
    expect(entry["password"]).toBe("[REDACTED]");
  });

  it("attaches a requestId via child loggers", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);

    forRequest(log, "req-1").info("handled");

    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["requestId"]).toBe("req-1");
    expect(entry["service"]).toBe("harbor");
  });
});
