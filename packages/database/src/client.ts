import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type { Sql };

export interface DatabaseClient {
  sql: Sql;
  db: Db;
}

export function createClient(url: string, options: { max?: number } = {}): DatabaseClient {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }) };
}

export async function closeClient(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
