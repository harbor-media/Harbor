import { fileURLToPath } from "node:url";

export const MIGRATIONS_FOLDER =
  process.env["HARBOR_MIGRATIONS_DIR"] ??
  fileURLToPath(new URL("../../../packages/database/drizzle", import.meta.url));
