import { isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { installation, users, type User } from "./schema.js";

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Setup has already been completed.");
    this.name = "SetupAlreadyCompleteError";
  }
}

export interface CompleteSetupInput {
  serverName: string;
  language: string;
  username: string;
  email: string;
  passwordHash: string;
}

/**
 * Marks setup complete and creates the owner in one transaction, update-first.
 *
 * Update-first means the race guard runs before any other work: the conditional
 * UPDATE returns zero rows for every caller but the winner. Doing the insert
 * first would risk a completed install with no owner, which is unrecoverable.
 *
 * Throwing inside the callback rolls the transaction back, so any failure —
 * duplicate username, constraint violation, crash — leaves setup incomplete
 * and therefore retryable.
 *
 * The password must already be hashed. Hashing is deliberately kept outside so
 * a ~100ms Argon2 computation does not hold the transaction open.
 */
export async function completeSetupWithOwner(db: Db, input: CompleteSetupInput): Promise<User> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(installation)
      .set({
        setupCompletedAt: new Date(),
        serverName: input.serverName,
        language: input.language,
      })
      .where(isNull(installation.setupCompletedAt))
      .returning();

    if (claimed.length === 0) throw new SetupAlreadyCompleteError();

    const created = await tx
      .insert(users)
      .values({
        username: input.username.trim().toLowerCase(),
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        role: "owner",
      })
      .returning();

    const owner = created[0];
    if (!owner) throw new Error("owner insert returned no row");
    return owner;
  });
}
