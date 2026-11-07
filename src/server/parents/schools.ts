import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database, Transaction } from "../db/client";
import { setTenantContext, withTenant } from "../db/context";
import { guardians, tenantEntitlements, tenants } from "../db/schema";

export interface ParentSchoolRef {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}

/**
 * The schools (active) that have this number on file for a guardian who is not blocked from the parent
 * view. This is the only read across schools: it sets app.parent_phone so that row-level security shows
 * guardian rows with exactly this number (migration 0039), and returns schools only. Each school's data
 * is then read in its own tenant transaction.
 */
export async function schoolsForPhone(database: Database, phone: string): Promise<ParentSchoolRef[]> {
  const found = await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.parent_phone', ${phone}, true)`);
    return tx
      .selectDistinct({ id: tenants.id, slug: tenants.slug, name: tenants.name, timezone: tenants.timezone })
      .from(guardians)
      .innerJoin(tenants, eq(tenants.id, guardians.tenantId))
      .where(
        and(
          eq(guardians.phone, phone),
          isNull(guardians.portalBlockedAt),
          eq(tenants.status, "active"),
          // Demo schools have made-up guardian numbers that may match a real parent's.
          eq(tenants.isDemo, false),
        ),
      )
      .orderBy(tenants.name);
  });
  const offered = await Promise.all(found.map((school) => offersParentView(database, school.id)));
  return found.filter((_, i) => offered[i]);
}

/** In the tenant transaction given: the school's plan includes the parent view (no plan row: it does). */
export async function planIncludesParentView(tx: Transaction, tenantId: string): Promise<boolean> {
  await setTenantContext(tx, { tenantId, userId: "" });
  const [plan] = await tx
    .select({ features: tenantEntitlements.features })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  return !plan || plan.features.includes("parent_view");
}

async function offersParentView(database: Database, tenantId: string): Promise<boolean> {
  return withTenant(database, { tenantId, userId: "" }, (tx) => planIncludesParentView(tx, tenantId));
}

/** An active school by slug, for the parent view (never a demo school; access is checked separately). */
export async function schoolBySlug(database: Database, slug: string): Promise<ParentSchoolRef | null> {
  const [row] = await database
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, timezone: tenants.timezone })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active"), eq(tenants.isDemo, false)))
    .limit(1);
  if (!row || !(await offersParentView(database, row.id))) return null;
  return row;
}
