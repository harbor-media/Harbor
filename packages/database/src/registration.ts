import type { Db } from "./client.js";
import { installation } from "./schema.js";

// Structurally identical to @harbor/shared's RegistrationMode; duplicated here
// because this package does not depend on @harbor/shared (see plan decisions).
export type RegistrationMode = "disabled" | "invitation-only" | "open";

export async function getRegistrationMode(db: Db): Promise<RegistrationMode> {
  const rows = await db
    .select({ mode: installation.registrationMode })
    .from(installation)
    .limit(1);
  return rows[0]?.mode ?? "invitation-only";
}

export async function setRegistrationMode(db: Db, mode: RegistrationMode): Promise<void> {
  await db.update(installation).set({ registrationMode: mode });
}
