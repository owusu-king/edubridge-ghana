import "server-only";
import { eq } from "drizzle-orm";
import { curriculumTemplate, type CurriculumTemplate } from "../../lib/curricula";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import type { TenantContext } from "../tenancy/service";
import { tenants } from "../db/schema";
import { readPreferences } from "../tenancy/preferences";

/**
 * The starter template a school uses (its choice, else its country's), inside its tenant transaction.
 * Defaults for levels, subjects, grade bands and assessment parts come from here.
 */
export async function readTemplate(tx: Queryable, tenantId: string): Promise<CurriculumTemplate> {
  const prefs = await readPreferences(tx, tenantId);
  const [tenant] = await tx
    .select({ country: tenants.countryCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return curriculumTemplate(prefs.curriculumTemplate, tenant?.country ?? "GH");
}

/** The school's template, for screens. */
export async function getTemplate(database: Database, ctx: TenantContext): Promise<CurriculumTemplate> {
  return withTenant(
    database,
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    (tx) => readTemplate(tx, ctx.tenant.id),
  );
}
