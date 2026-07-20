import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { invitations, users, type User } from "./schema.js";

export class InvitationUnusableError extends Error {
  constructor() {
    super("This invitation is no longer usable.");
    this.name = "InvitationUnusableError";
  }
}

export class InviteEmailMismatchError extends Error {
  constructor() {
    super("This invitation is bound to a different email address.");
    this.name = "InviteEmailMismatchError";
  }
}

export interface RedeemInvitationInput {
  tokenHash: string;
  username: string;
  email: string;
  passwordHash: string;
}

/**
 * Single transaction, conditional-update-first — mirrors completeSetupWithOwner.
 * The UPDATE increments use_count only if the invite is still spendable, and
 * takes a row lock so a concurrent second redeemer re-evaluates use_count <
 * max_uses AFTER the first commits and matches zero rows. Because the user
 * INSERT shares the transaction, any failure (e.g. duplicate username) rolls
 * back the use increment, so a failed registration never burns a use.
 */
export async function redeemInvitation(db: Db, input: RedeemInvitationInput): Promise<User> {
  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(invitations)
      .set({ useCount: sql`${invitations.useCount} + 1` })
      .where(
        and(
          eq(invitations.tokenHash, input.tokenHash),
          isNull(invitations.revokedAt),
          or(isNull(invitations.expiresAt), gt(invitations.expiresAt, sql`now()`)),
          lt(invitations.useCount, invitations.maxUses),
        ),
      )
      .returning({ role: invitations.role, email: invitations.email });

    const invite = consumed[0];
    if (!invite) throw new InvitationUnusableError();

    if (invite.email !== null && invite.email !== input.email.trim().toLowerCase()) {
      throw new InviteEmailMismatchError();
    }

    const created = await tx
      .insert(users)
      .values({
        username: input.username.trim().toLowerCase(),
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        role: invite.role,
      })
      .returning();
    const user = created[0];
    if (!user) throw new Error("user insert returned no row");
    return user;
  });
}
