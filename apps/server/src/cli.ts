import { loadEnv } from "@harbor/config";
import { runMigrations } from "@harbor/database";
import { createLogger, redactSecretsFromText } from "@harbor/logger";
import { MIGRATIONS_FOLDER } from "./paths.js";

const USAGE = "Usage: harbor <migrate>\n";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== "migrate") {
    process.stderr.write(USAGE);
    process.exit(command === undefined ? 1 : 2);
  }

  const env = loadEnv();
  const logger = createLogger({
    level: env.HARBOR_LOG_LEVEL,
    production: env.NODE_ENV === "production",
  });

  logger.info("applying migrations");
  await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
  logger.info("migrations applied");
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${redactSecretsFromText(String(error))}\n`);
  process.exit(1);
});
