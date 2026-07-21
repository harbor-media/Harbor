import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// HARBOR_SECRET is a general-purpose installation secret. It is never used
// directly as an encryption key: HKDF derives a key bound to this specific
// purpose, so a future use of HARBOR_SECRET elsewhere cannot produce a
// colliding key. The info string carries a version so the derivation can
// change without ambiguity about which key decrypts an old value.
const HKDF_INFO = "harbor:provider-credentials:v1";
const HKDF_SALT = "harbor-provider-credentials";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

function deriveKey(harborSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", harborSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

export function encryptSecret(plaintext: string, harborSecret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(harborSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(envelope: string, harborSecret: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError("Stored credential is not a recognized envelope.");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(harborSecret),
      Buffer.from(parts[1]!, "base64"),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // The underlying error is deliberately not chained: it can carry key
    // material context, and callers only need to know the credential is
    // unusable and must be re-entered.
    throw new SecretDecryptionError(
      "Stored credential could not be decrypted. If HARBOR_SECRET changed, re-enter the provider key.",
    );
  }
}
