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

/** Inserts the singleton row if absent. Safe to call on every boot. */
export async function ensureInstallationRow(db: Db): Promise<void> {
  await db.insert(installation).values({ id: true }).onConflictDoNothing();
}
