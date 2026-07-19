import { isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { installation, type Installation } from "./schema.js";

export async function getInstallation(db: Db): Promise<Installation | null> {
  const rows = await db.select().from(installation).limit(1);
  return rows[0] ?? null;
}

export async function isSetupComplete(db: Db): Promise<boolean> {
  const record = await getInstallation(db);
  return record?.setupCompletedAt != null;
}

/**
 * Marks setup complete. Returns null when another caller got there first.
 *
 * The WHERE clause is the concurrency guard: the conditional UPDATE is atomic,
 * so exactly one caller can transition the row out of the incomplete state.
 */
export async function completeSetup(db: Db): Promise<Installation | null> {
  const rows = await db
    .update(installation)
    .set({ setupCompletedAt: new Date() })
    .where(isNull(installation.setupCompletedAt))
    .returning();
  return rows[0] ?? null;
}

/** Inserts the singleton row if absent. Safe to call on every boot. */
export async function ensureInstallationRow(db: Db): Promise<void> {
  await db.insert(installation).values({ id: true }).onConflictDoNothing();
}
