import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, SecretDecryptionError } from "./index.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(decryptSecret(envelope, SECRET)).toBe("tmdb-api-key-value");
  });

  it("never emits the plaintext inside the envelope", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(envelope).not.toContain("tmdb-api-key-value");
    expect(envelope.startsWith("v1:")).toBe(true);
  });

  // A random IV per encryption is what stops two identical keys producing
  // identical ciphertext, which would leak that two installs share a key.
  it("produces different ciphertext for the same plaintext", () => {
    const a = encryptSecret("same-value", SECRET);
    const b = encryptSecret("same-value", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe(decryptSecret(b, SECRET));
  });

  // Rotating HARBOR_SECRET must fail loudly, not silently yield garbage or
  // report the credential as absent.
  it("refuses to decrypt under a different secret", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    expect(() => decryptSecret(envelope, OTHER_SECRET)).toThrow(SecretDecryptionError);
  });

  // The GCM auth tag is the whole point of choosing GCM: a hand-edited or
  // corrupted database row must be detected rather than decrypted to junk.
  it("detects tampered ciphertext", () => {
    const envelope = encryptSecret("tmdb-api-key-value", SECRET);
    const parts = envelope.split(":");
    const ciphertext = Buffer.from(parts[3]!, "base64");
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    parts[3] = ciphertext.toString("base64");
    expect(() => decryptSecret(parts.join(":"), SECRET)).toThrow(SecretDecryptionError);
  });

  it("rejects a malformed envelope", () => {
    expect(() => decryptSecret("not-an-envelope", SECRET)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("v2:a:b:c", SECRET)).toThrow(SecretDecryptionError);
  });
});
