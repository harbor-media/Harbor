import { createHash, randomBytes } from "node:crypto";

/** 256 bits of entropy, URL-safe. The raw token lives only in the invite link. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the SHA-256 hash is stored; a database leak exposes no usable invites. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
