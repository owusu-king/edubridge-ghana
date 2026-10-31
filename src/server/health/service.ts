import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

/** True when the database answers a trivial query. */
export async function databaseIsHealthy(database: Database): Promise<boolean> {
  try {
    await database.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
