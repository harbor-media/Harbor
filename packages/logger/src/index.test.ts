import { describe, expect, it } from "vitest";
import { createLogger, forRequest, redactSecretsFromText } from "./index.js";

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

  it("redacts compound secret key names", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);

    log.info(
      {
        sessionToken: "sess-tok-abc123xyz",
        accessToken: "access-tok-def456uvw",
        refreshToken: "refresh-tok-ghi789rst",
        apiToken: "api-tok-jkl012pqr",
        clientSecret: "client-secret-mno345stu",
        hashedPassword: "$argon2id$v=19$m=65536,t=3,p=4$abc123$def456",
        passwordHash: "bcrypt-hash-vwx789yz",
        providerApiKey: "provider-key-abc123xyz",
        encryptionKey: "encryption-key-def456uvw",
        session: { refreshToken: "nested-refresh-tok-123" },
        userId: "user-12345",
      },
      "authentication configured",
    );

    expect(lines).toHaveLength(1);
    const raw = lines[0]!;

    // Verify secret values do not appear
    expect(raw).not.toContain("sess-tok-abc123xyz");
    expect(raw).not.toContain("access-tok-def456uvw");
    expect(raw).not.toContain("refresh-tok-ghi789rst");
    expect(raw).not.toContain("api-tok-jkl012pqr");
    expect(raw).not.toContain("client-secret-mno345stu");
    expect(raw).not.toContain("$argon2id$v=19$m=65536,t=3,p=4$abc123$def456");
    expect(raw).not.toContain("bcrypt-hash-vwx789yz");
    expect(raw).not.toContain("provider-key-abc123xyz");
    expect(raw).not.toContain("encryption-key-def456uvw");
    expect(raw).not.toContain("nested-refresh-tok-123");

    // Verify non-secret fields survive
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry["msg"]).toBe("authentication configured");
    expect(entry["userId"]).toBe("user-12345");
    expect(entry["sessionToken"]).toBe("[REDACTED]");
    expect(entry["accessToken"]).toBe("[REDACTED]");
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

describe("redactSecretsFromText", () => {
  it("masks a password-bearing connection string while keeping scheme/host/port/database readable", () => {
    const input = "connect ECONNREFUSED postgresql://harbor:s3cret@db:5432/harbor";
    const output = redactSecretsFromText(input);

    expect(output).not.toContain("s3cret");
    expect(output).not.toContain("harbor:s3cret");
    expect(output).toBe("connect ECONNREFUSED postgresql://***:***@db:5432/harbor");
  });

  it("masks a username-only URL", () => {
    const input = "failed to connect: postgres://harbor@host/db";
    const output = redactSecretsFromText(input);

    expect(output).not.toContain("harbor@host");
    expect(output).toBe("failed to connect: postgres://***@host/db");
  });

  it("masks multiple URLs in one string", () => {
    const input =
      "primary postgresql://harbor:s3cret@db1:5432/harbor replica postgresql://harbor:s3cret@db2:5432/harbor";
    const output = redactSecretsFromText(input);

    expect(output).not.toContain("s3cret");
    expect(output).toBe(
      "primary postgresql://***:***@db1:5432/harbor replica postgresql://***:***@db2:5432/harbor",
    );
  });

  it("leaves a string with no URL completely unchanged", () => {
    const input = "connection refused: connect ECONNREFUSED 127.0.0.1:5432";
    expect(redactSecretsFromText(input)).toBe(input);
  });
});
