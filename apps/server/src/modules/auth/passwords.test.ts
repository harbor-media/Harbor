import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";

describe("password hashing", () => {
  it("produces a PHC string with the configured Argon2id parameters", async () => {
    const hash = await hashPassword("correct horse battery staple");

    // Guards the trap: @node-rs/argon2@2.0.2 defaults to m=4096,t=3.
    // If parameters were not passed explicitly, this assertion fails.
    // The `$argon2id$` prefix additionally proves the inlined ARGON2ID = 2
    // constant is the right numeric value for Argon2id.
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
    expect(hash).toContain("p=1");
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash).not.toContain("hunter2");
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("accepts the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(await verifyPassword(hash, "s3cret-password")).toBe(true);
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    // argon2 REJECTS on a malformed PHC string. If this propagated, a corrupt
    // row would surface as a 500 instead of a failed login.
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
    await expect(verifyPassword("", "anything")).resolves.toBe(false);
  });

  it("verifyAgainstDummy resolves without throwing", async () => {
    await expect(verifyAgainstDummy()).resolves.toBeUndefined();
  });
});
