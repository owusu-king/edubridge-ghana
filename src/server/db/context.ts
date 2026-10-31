import "server-only";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client";

export interface TenantScope {
  tenantId: string;
  userId: string;
}

/**
 * Runs `fn` in a transaction where row-level security is scoped to one tenant.
 * Settings are transaction-local (`set_config(..., true)`) so pooled connections never leak context.
 * All reads and writes of tenant-owned tables must go through this function.
 */
export async function withTenant<T>(
  database: Database,
  scope: TenantScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.user_id', ${scope.userId}, true)`,
    );
    return fn(tx);
  });
}

/** Runs `fn` with only a user context: the user can see their own memberships across tenants. */
export async function withUser<T>(
  database: Database,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
