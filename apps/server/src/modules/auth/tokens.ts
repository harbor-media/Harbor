import { createHash, randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 bytes of CSPRNG entropy, base64url encoded for cookie safety. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only this hash is stored. The raw token lives in the cookie and nowhere else,
 * so a database dump or SQL-injection read yields nothing usable — the same
 * reasoning that applies to passwords.
 *
 * SHA-256 without a salt is correct here, unlike for passwords: the input is
 * already 256 bits of uniform randomness, so there is nothing to brute-force
 * and per-value salting would only prevent the O(1) lookup this design needs.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS);
}
