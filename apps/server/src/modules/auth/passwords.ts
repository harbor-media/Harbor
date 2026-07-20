import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** Algorithm.Argon2id === 2. Inlined because @node-rs/argon2 declares Algorithm
 *  as an ambient `const enum`, which `isolatedModules: true` forbids importing. */
const ARGON2ID = 2;

/**
 * OWASP's balanced Argon2id profile, sized for the home servers and small VPSes
 * Harbor targets.
 *
 * These MUST be passed explicitly. @node-rs/argon2@2.0.2 defaults to
 * memoryCost 4096 / timeCost 3 — its GitHub README documents a later release's
 * stronger defaults, so relying on them silently weakens hashing.
 */
const HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/**
 * Verification parameters come from the stored PHC string, so options are not
 * passed here. Returns false for a wrong password AND for a malformed hash —
 * argon2 rejects on the latter, and an unreadable hash is an authentication
 * failure, not a server error.
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/**
 * Computed once on first use and cached, so login spends comparable time
 * whether or not the account exists. Without this, a fast "no such user"
 * response leaks which usernames are registered.
 */
let dummyHash: Promise<string> | null = null;

export async function verifyAgainstDummy(): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(await dummyHash, "wrong");
}
