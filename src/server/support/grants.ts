import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Transaction } from "../db/client";
import { supportGrants } from "../db/schema";

export interface LiveGrant {
  id: string;
  expiresAt: Date;
}

/** The school's live support grant, if any (inside a tenant transaction). */
export async function readLiveGrant(tx: Transaction, tenantId: string): Promise<LiveGrant | null> {
  const [row] = await tx
    .select({ id: supportGrants.id, expiresAt: supportGrants.expiresAt })
    .from(supportGrants)
    .where(
      and(
        eq(supportGrants.tenantId, tenantId),
        isNull(supportGrants.endedAt),
        gt(supportGrants.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(supportGrants.createdAt))
    .limit(1);
  return row ?? null;
}
