import { createHash } from "node:crypto";

/**
 * The two dimensions get deliberately asymmetric budgets.
 *
 * FREE_ATTEMPTS guards a single account — a targeted password-guessing attack —
 * so it is tight.
 *
 * IP_FREE_ATTEMPTS only blunts broad scanning, and it must stay generous
 * because it is a self-denial-of-service vector: HARBOR_TRUST_PROXY is easy to
 * misconfigure on a self-hosted install, and when it is wrong every request
 * appears to originate from the reverse proxy. Sharing the tight budget would
 * mean three bad logins from anyone locking out the entire installation.
 */
export const FREE_ATTEMPTS = 3;
export const IP_FREE_ATTEMPTS = 20;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
const DEFAULT_CAPACITY = 10_000;

/** Doubling backoff after a few free attempts, capped so nothing locks out. */
export function backoffMs(failedCount: number, freeAttempts: number = FREE_ATTEMPTS): number {
  if (failedCount < freeAttempts) return 0;
  const scaled = BASE_BACKOFF_MS * 2 ** (failedCount - freeAttempts);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

/** Seconds the caller must wait, or 0 when not throttled. */
export function retryAfterSeconds(
  failedCount: number,
  lastFailedAt: Date | null,
  now: Date = new Date(),
  freeAttempts: number = FREE_ATTEMPTS,
): number {
  if (lastFailedAt === null) return 0;
  const window = backoffMs(failedCount, freeAttempts);
  if (window === 0) return 0;
  const remaining = lastFailedAt.getTime() + window - now.getTime();
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

/**
 * Stable, non-reversible key for a submitted identifier. Tracking unknown
 * identifiers is what lets login answer 429 identically whether or not the
 * account exists (see Task 12); hashing means the store never holds a list of
 * attempted usernames or email addresses in memory.
 */
export function identifierKey(identifier: string): string {
  return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
}

interface AttemptEntry {
  count: number;
  lastFailedAt: Date;
}

/**
 * Bounded in-memory failure tracking, keyed by an opaque string so the same
 * structure serves both the source-IP and the unknown-identifier dimension.
 *
 * In memory rather than the database on purpose: a write per failed guess would
 * itself be a denial-of-service vector. State is lost on restart, which is
 * acceptable because per-account throttling — which does persist in
 * `users.failed_login_count` — is what defends a targeted attack.
 *
 * Capacity-bounded with oldest-first eviction so an attacker rotating source
 * addresses or identifiers cannot exhaust memory.
 */
export class AttemptThrottle {
  readonly #entries = new Map<string, AttemptEntry>();
  readonly #freeAttempts: number;
  readonly #capacity: number;

  constructor(freeAttempts: number = FREE_ATTEMPTS, capacity: number = DEFAULT_CAPACITY) {
    this.#freeAttempts = freeAttempts;
    this.#capacity = capacity;
  }

  record(key: string, now: Date = new Date()): void {
    const existing = this.#entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastFailedAt = now;
      // Re-insert to mark as most recently used.
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return;
    }

    if (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { count: 1, lastFailedAt: now });
  }

  retryAfter(key: string, now: Date = new Date()): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    return retryAfterSeconds(entry.count, entry.lastFailedAt, now, this.#freeAttempts);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}
