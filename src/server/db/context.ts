import "server-only";
import { sql } from "drizzle-orm";
import { DomainError } from "../errors";
import type { Database, Transaction } from "./client";

export interface TenantScope {
  tenantId: string;
  userId: string;
  /**
   * Set when EduBridge support is acting under a support grant (PLT-02): every audit event recorded in the
   * transaction carries it (the column's default reads it).
   */
  supportGrantId?: string | null;
}

/**
 * Runs `fn` in a transaction where row-level security is scoped to one tenant.
 * Settings are transaction-local (`set_config(..., true)`) so pooled connections never leak context.
 * All reads and writes of tenant-owned tables must go through this function.
 */
/**
 * Sets the tenant context on an open transaction, e.g. after creating the tenant in that transaction.
 * A demo visitor's transactions (the shared account behind "Try the demo school") are made read-only in the
 * same statement, so the database refuses any change they attempt, whichever service or page asks.
 */
export async function setTenantContext(tx: Transaction, scope: TenantScope): Promise<void> {
  await tx.execute(
    sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.user_id', ${scope.userId}, true), set_config('app.support_grant_id', ${scope.supportGrantId ?? ""}, true), (select set_config('transaction_read_only', 'on', true) from demo_visitors where user_id::text = ${scope.userId})`,
  );
}

/** Shown when a demo visitor tries to change something (the database refused it: see setTenantContext). */
export const DEMO_VIEW_ONLY =
  "This is the demo school: you can look round everything, but changes are switched off.";

export async function withTenant<T>(
  database: Database,
  scope: TenantScope,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database
    .transaction(async (tx) => {
      await setTenantContext(tx, scope);
      return fn(tx);
    })
    .catch((error: unknown) => {
      throw explainDatabaseError(error);
    });
}

/**
 * Errors raised by database rules that people can act on, as a domain error with a plain message (the
 * rule itself stays in the database, so no code path can bypass it).
 */
function explainDatabaseError(error: unknown): unknown {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    cause?: { message?: unknown; code?: unknown };
  };
  const message = String(candidate.cause?.message ?? candidate.message ?? "");
  // 25006: read_only_sql_transaction, raised only for a demo visitor's transactions.
  if ((candidate.cause?.code ?? candidate.code) === "25006" || /read-only transaction/.test(message))
    return new DomainError("demo_view_only", DEMO_VIEW_ONLY);
  const locked = /period_locked:(\d{4}-\d{2}-\d{2})/.exec(message);
  if (locked)
    return new DomainError(
      "period_locked",
      `The books are closed up to ${locked[1]}. Use a later date, or ask the Proprietor to reopen the period.`,
    );
  return error;
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
