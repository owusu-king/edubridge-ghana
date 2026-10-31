import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the root database or an open transaction. */
export type Queryable = Database | Transaction;

const globalForDb = globalThis as unknown as { edubridgeDb?: { pool: Pool; db: Database } };

export function createDatabase(connectionString: string): { pool: Pool; db: Database } {
  const pool = new Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}

/** Shared runtime database (restricted role). Reused across hot reloads in development. */
export function db(): Database {
  if (!globalForDb.edubridgeDb) {
    globalForDb.edubridgeDb = createDatabase(env().DATABASE_URL);
  }
  return globalForDb.edubridgeDb.db;
}
