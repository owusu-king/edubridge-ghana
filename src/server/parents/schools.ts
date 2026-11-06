import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { guardians, tenants } from "../db/schema";

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
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.parent_phone', ${phone}, true)`);
    return tx
      .selectDistinct({ id: tenants.id, slug: tenants.slug, name: tenants.name, timezone: tenants.timezone })
      .from(guardians)
      .innerJoin(tenants, eq(tenants.id, guardians.tenantId))
      .where(and(eq(guardians.phone, phone), isNull(guardians.portalBlockedAt), eq(tenants.status, "active")))
      .orderBy(tenants.name);
  });
}

/** An active school by slug (schools are public records; access is checked separately). */
export async function schoolBySlug(database: Database, slug: string): Promise<ParentSchoolRef | null> {
  const [row] = await database
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, timezone: tenants.timezone })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")))
    .limit(1);
  return row ?? null;
}
