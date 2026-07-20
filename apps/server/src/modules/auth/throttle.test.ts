import { describe, expect, it } from "vitest";
import {
  AttemptThrottle,
  FREE_ATTEMPTS,
  IP_FREE_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffMs,
  identifierKey,
  retryAfterSeconds,
} from "./throttle.js";

describe("backoffMs", () => {
  it("allows the first attempts with no delay", () => {
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect(backoffMs(i)).toBe(0);
  });

  it("doubles after the free attempts and caps", () => {
    expect(backoffMs(FREE_ATTEMPTS)).toBe(1000);
    expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(2000);
    expect(backoffMs(FREE_ATTEMPTS + 2)).toBe(4000);
    expect(backoffMs(100)).toBe(MAX_BACKOFF_MS);
  });

  it("never exceeds the ceiling", () => {
    for (let i = 0; i < 200; i++) expect(backoffMs(i)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe("retryAfterSeconds", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("is zero while attempts remain free", () => {
    expect(retryAfterSeconds(0, null, at)).toBe(0);
    expect(retryAfterSeconds(FREE_ATTEMPTS - 1, at, at)).toBe(0);
  });

  it("reports remaining seconds inside the window", () => {
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, at)).toBe(4);
    const half = new Date(at.getTime() + 2000);
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, half)).toBe(2);
  });

  it("is zero once the window has elapsed", () => {
    const later = new Date(at.getTime() + 10_000);
    expect(retryAfterSeconds(FREE_ATTEMPTS + 2, at, later)).toBe(0);
  });

  it("is zero when there is no recorded failure", () => {
    expect(retryAfterSeconds(99, null, at)).toBe(0);
  });
});

describe("AttemptThrottle", () => {
  const at = new Date("2026-01-01T00:00:00Z");

  it("throttles only after its free attempts", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS; i++) t.record("1.2.3.4", at);
    expect(t.retryAfter("1.2.3.4", at)).toBe(1);
  });

  it("tracks keys independently", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("1.1.1.1", at);
    expect(t.retryAfter("1.1.1.1", at)).toBeGreaterThan(0);
    expect(t.retryAfter("2.2.2.2", at)).toBe(0);
  });

  it("resets on success", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("9.9.9.9", at);
    t.reset("9.9.9.9");
    expect(t.retryAfter("9.9.9.9", at)).toBe(0);
  });

  it("evicts the oldest entries past its cap so it cannot grow unbounded", () => {
    const t = new AttemptThrottle(FREE_ATTEMPTS, 3);
    for (const ip of ["a", "b", "c", "d"]) {
      for (let i = 0; i < FREE_ATTEMPTS + 1; i++) t.record(ip, at);
    }
    // "a" was evicted when "d" arrived, so it is no longer throttled.
    expect(t.retryAfter("a", at)).toBe(0);
    expect(t.retryAfter("d", at)).toBeGreaterThan(0);
  });

  it("gives the IP dimension a far larger budget than the account dimension", () => {
    // Guards a self-DoS: HARBOR_TRUST_PROXY is easy to misconfigure, and when
    // it is wrong every request appears to come from the reverse proxy. With a
    // shared budget of 3, three bad logins anywhere would lock out the whole
    // installation.
    expect(IP_FREE_ATTEMPTS).toBeGreaterThan(FREE_ATTEMPTS * 5);

    const t = new AttemptThrottle(IP_FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS + 2; i++) t.record("10.0.0.1", at);
    expect(t.retryAfter("10.0.0.1", at)).toBe(0);
  });
});

describe("identifierKey", () => {
  it("is stable, case-insensitive and never echoes the identifier", () => {
    const key = identifierKey("Owner@Example.com ");
    expect(key).toBe(identifierKey("owner@example.com"));
    expect(key).not.toContain("owner");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
