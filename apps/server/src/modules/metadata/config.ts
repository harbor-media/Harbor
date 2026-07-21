import { decryptSecret } from "@harbor/crypto";
import { getMetadataProviderConfig, type Db } from "@harbor/database";
import { createTmdbProvider } from "./providers/tmdb.js";
import type { MetadataProvider } from "./providers/types.js";

export class MetadataNotConfiguredError extends Error {
  constructor() {
    super("No metadata provider is configured.");
    this.name = "MetadataNotConfiguredError";
  }
}

export interface LoadedProvider {
  provider: MetadataProvider;
  language: string;
}

/** Builds the real TMDB provider, honoring an operator-configured base URL. */
export function tmdbFactory(tmdbBaseUrl?: string): (apiKey: string) => MetadataProvider {
  return (key) => createTmdbProvider(key, tmdbBaseUrl === undefined ? {} : { baseUrl: tmdbBaseUrl });
}

export async function loadProvider(
  db: Db,
  harborSecret: string,
  providerFactory?: (apiKey: string) => MetadataProvider,
  tmdbBaseUrl?: string,
): Promise<LoadedProvider> {
  const config = await getMetadataProviderConfig(db, "tmdb");
  if (!config || !config.enabled || !config.encryptedApiKey) {
    throw new MetadataNotConfiguredError();
  }

  // A decryption failure propagates as SecretDecryptionError rather than
  // being flattened into "not configured". An operator who rotated
  // HARBOR_SECRET needs to be told that, not sent to re-run onboarding.
  const apiKey = decryptSecret(config.encryptedApiKey, harborSecret);
  const factory = providerFactory ?? tmdbFactory(tmdbBaseUrl);
  return { provider: factory(apiKey), language: config.language };
}
