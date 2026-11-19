import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "../db/client";
import { memberships, users } from "../db/schema";

/** The school's Proprietors (active members with the owner role): who EduBridge's billing emails go to. */
export async function proprietorEmails(tx: Transaction, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        sql`'owner' = any(${memberships.roles})`,
      ),
    );
  return [...new Set(rows.map((r) => r.email))];
}
