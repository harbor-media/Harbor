import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { metadataProviderConfig } from "./schema.js";

export interface MetadataProviderConfigRow {
  providerId: string;
  enabled: boolean;
  encryptedApiKey: string | null;
  language: string;
  lastVerifiedAt: Date | null;
}

export interface SaveMetadataProviderConfigInput {
  providerId: string;
  enabled: boolean;
  encryptedApiKey: string;
  language: string;
  lastVerifiedAt: Date;
}

export async function getMetadataProviderConfig(
  db: Db,
  providerId: string,
): Promise<MetadataProviderConfigRow | null> {
  const rows = await db
    .select()
    .from(metadataProviderConfig)
    .where(eq(metadataProviderConfig.providerId, providerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    providerId: row.providerId,
    enabled: row.enabled,
    encryptedApiKey: row.encryptedApiKey,
    language: row.language,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export async function saveMetadataProviderConfig(
  db: Db,
  input: SaveMetadataProviderConfigInput,
): Promise<void> {
  await db
    .insert(metadataProviderConfig)
    .values({
      providerId: input.providerId,
      enabled: input.enabled,
      encryptedApiKey: input.encryptedApiKey,
      language: input.language,
      lastVerifiedAt: input.lastVerifiedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: metadataProviderConfig.providerId,
      set: {
        enabled: input.enabled,
        encryptedApiKey: input.encryptedApiKey,
        language: input.language,
        lastVerifiedAt: input.lastVerifiedAt,
        updatedAt: new Date(),
      },
    });
}
