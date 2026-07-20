import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { invitations, type Invitation } from "./schema.js";

export type InvitationStatus = "active" | "spent" | "expired" | "revoked";

export interface CreateInvitationInput {
  tokenHash: string;
  createdBy: string;
  role: Invitation["role"];
  email: string | null;
  maxUses: number;
  expiresAt: Date | null;
}

export interface InvitationSummary {
  id: string;
  role: Invitation["role"];
  email: string | null;
  status: InvitationStatus;
  useCount: number;
  maxUses: number;
  expiresAt: Date | null;
  createdAt: Date;
}

export async function createInvitation(db: Db, input: CreateInvitationInput): Promise<Invitation> {
  const created = await db
    .insert(invitations)
    .values({
      tokenHash: input.tokenHash,
      createdBy: input.createdBy,
      role: input.role,
      email: input.email === null ? null : input.email.trim().toLowerCase(),
      maxUses: input.maxUses,
      expiresAt: input.expiresAt,
    })
    .returning();
  const row = created[0];
  if (!row) throw new Error("invitation insert returned no row");
  return row;
}

export async function findInvitationByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<Invitation | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Single source of truth for validity. An invite is spendable when it has a
 *  use left, is not revoked, and is not past its expiry. */
export function deriveInvitationStatus(
  row: { useCount: number; maxUses: number; revokedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): InvitationStatus {
  if (row.revokedAt !== null) return "revoked";
  if (row.useCount >= row.maxUses) return "spent";
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export async function listInvitations(db: Db): Promise<InvitationSummary[]> {
  const rows = await db.select().from(invitations).orderBy(desc(invitations.createdAt));
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    email: row.email,
    status: deriveInvitationStatus(row),
    useCount: row.useCount,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

/** Sets revoked_at only if not already revoked. Returns whether a row changed. */
export async function revokeInvitation(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  return updated.length > 0;
}
