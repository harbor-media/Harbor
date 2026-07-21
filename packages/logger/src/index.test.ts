import { describe, expect, it } from "vitest";
import { createLogger, forRequest, redactSecretsFromText, redactUrl } from "./index.js";

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

describe("redactUrl", () => {
  // The raw invite token is a bearer credential that can create an account,
  // potentially an administrator one. It rides in the URL path of the public
  // inspect route, so it must never reach an access log verbatim.
  it("masks the token segment of the invite-inspection route", () => {
    const token = "Xh2n4Kq8vTdR7bLpZ0aJmWcF3sYuE1gN6oQiP5rtBkA";
    const output = redactUrl(`/api/v1/invitations/${token}`);

    expect(output).not.toContain(token);
    expect(output).toBe("/api/v1/invitations/[redacted]");
  });

  it("masks the token but keeps a trailing query string readable", () => {
    const output = redactUrl("/api/v1/invitations/secret-token-value?trace=1");

    expect(output).not.toContain("secret-token-value");
    expect(output).toBe("/api/v1/invitations/[redacted]?trace=1");
  });

  // The admin list route has no trailing segment and carries no secret;
  // mangling it would make access logs harder to read for no security gain.
  it("leaves the admin list route unchanged", () => {
    expect(redactUrl("/api/v1/invitations")).toBe("/api/v1/invitations");
    expect(redactUrl("/api/v1/invitations?status=active")).toBe(
      "/api/v1/invitations?status=active",
    );
  });

  it("leaves unrelated URLs byte-for-byte unchanged", () => {
    expect(redactUrl("/api/v1/auth/me")).toBe("/api/v1/auth/me");
    expect(redactUrl("/invite/some-client-side-route")).toBe("/invite/some-client-side-route");
  });

  // Load-bearing wiring check: the masking function is worthless unless the
  // serializer that calls it is actually installed on the pino instance that
  // Fastify logs through. This asserts the serializer path, not just the regex.
  it("is applied to req.url through the configured logger's serializer", () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: "info", production: true }, stream);
    const token = "leaky-invite-token-abc123";

    log.info({ req: { method: "GET", url: `/api/v1/invitations/${token}` } }, "incoming request");

    const raw = lines[0]!;
    expect(raw).not.toContain(token);

    const entry = JSON.parse(raw) as { req: { method: string; url: string } };
    expect(entry.req.url).toBe("/api/v1/invitations/[redacted]");
    expect(entry.req.method).toBe("GET");
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

  // Guards against an over-broad pattern mangling ordinary links in error
  // messages. A URL without userinfo carries no credentials and must survive
  // byte-for-byte, or operator-facing errors become harder to act on.
  it("leaves URLs without credentials untouched", () => {
    const input =
      "migration failed; see https://harbor.example.com/docs/upgrade?from=1.0 for help";
    expect(redactSecretsFromText(input)).toBe(input);
  });
});
