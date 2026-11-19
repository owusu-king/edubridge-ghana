import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { todayIn } from "../../lib/format";
import {
  activeModules,
  isPlanModule,
  resolveModules,
  type ModuleGrant,
  type ModuleState,
  type PlanModuleId,
} from "../../lib/modules";
import type { Queryable } from "../db/client";
import {
  moduleReleaseAccess,
  platformSettings,
  schoolModules,
  tenantEntitlements,
  tenants,
} from "../db/schema";

/**
 * The entitlement resolver (ENT-01, ADR 0003): which modules a school can use today, from its plan, its
 * add-ons, trials and promotions, release access and module dependencies. Every enforcement point asks this
 * (the tenant context for pages, actions and the API; background jobs; the parent side), so a change made by
 * EduBridge staff applies on the next request or worker cycle. Read inside a transaction already scoped to
 * the school (RLS).
 */

export interface SchoolRef {
  id: string;
  isDemo: boolean;
  timezone: string;
}

export const DEFAULT_READ_ONLY_DAYS = 90;

export async function readModuleStates(
  tx: Queryable,
  school: SchoolRef,
  now: Date = new Date(),
): Promise<Record<string, ModuleState>> {
  const [plan] = await tx
    .select({ features: tenantEntitlements.features })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, school.id));
  const grants = await tx
    .select({
      module: schoolModules.module,
      source: schoolModules.source,
      startsOn: schoolModules.startsOn,
      endsOn: schoolModules.endsOn,
      endedAt: schoolModules.endedAt,
    })
    .from(schoolModules)
    .where(eq(schoolModules.tenantId, school.id));
  const access = await tx
    .select({ module: moduleReleaseAccess.module })
    .from(moduleReleaseAccess)
    .where(and(eq(moduleReleaseAccess.tenantId, school.id), isNull(moduleReleaseAccess.endedAt)));
  const [settings] = await tx
    .select({ readOnlyDays: platformSettings.moduleReadOnlyDays })
    .from(platformSettings)
    .limit(1);
  return resolveModules({
    planModules: plan ? plan.features : null,
    grants: grants.map((g): ModuleGrant => ({
      module: g.module,
      source: g.source,
      startsOn: g.startsOn,
      endsOn: g.endsOn,
      endedOn: g.endedAt ? todayIn(school.timezone, g.endedAt) : null,
    })),
    releaseAccess: access.map((a) => a.module),
    isDemo: school.isDemo,
    production: process.env.NODE_ENV === "production",
    today: todayIn(school.timezone, now),
    readOnlyDays: settings?.readOnlyDays ?? DEFAULT_READ_ONLY_DAYS,
  });
}

/** The modules active for a school today. */
export async function readActiveModules(
  tx: Queryable,
  school: SchoolRef,
  now: Date = new Date(),
): Promise<PlanModuleId[]> {
  return activeModules(await readModuleStates(tx, school, now));
}

/**
 * Whether one module is active for a school, for code that has only the school's id (background jobs and the
 * parent side). The transaction must already be scoped to that school.
 */
export async function moduleActive(
  tx: Queryable,
  tenantId: string,
  module: PlanModuleId,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isPlanModule(module)) return true;
  const [school] = await tx
    .select({ id: tenants.id, isDemo: tenants.isDemo, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!school) return false;
  return (await readModuleStates(tx, school, now))[module]?.state === "active";
}
