import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS,
  generateSessionToken,
  hashSessionToken,
  sessionExpiry,
} from "./tokens.js";

describe("session tokens", () => {
  it("generates url-safe tokens with adequate entropy", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url encodes to 43 characters.
    expect(token.length).toBe(43);
  });

  it("generates a distinct token every call", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(seen.size).toBe(200);
  });

  it("hashes deterministically and never returns the raw token", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different tokens", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });

  it("computes expiry from the TTL", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(sessionExpiry(from).getTime()).toBe(from.getTime() + SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
