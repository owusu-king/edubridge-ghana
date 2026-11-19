import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { parseMoney } from "../../lib/money";
import {
  ENTITLEMENT_SOURCES,
  MODULES,
  PLAN_CHOICES,
  activeModules,
  isPlanModule,
  isReleasedTo,
  missingDependencies,
  type EntitlementSource,
  type ModuleState,
  type PlanModuleId,
} from "../../lib/modules";
import { BILLING_PERIODS, type BillingPeriod } from "../../lib/plan";
import { recordAudit } from "../audit/record";
import type { Database, Transaction } from "../db/client";
import { withTenant, withUser } from "../db/context";
import {
  catalogPrices,
  moduleReleaseAccess,
  planPresets,
  platformEvents,
  platformSettings,
  schoolModules,
  tenantEntitlements,
  tenants,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { assertPlatformAdmin } from "../platform/service";
import { readModuleStates } from "./service";

/**
 * Platform staff manage what each school has beyond its plan (SUB-06), release access for modules not yet
 * generally released (REL-02) and the catalogue prices (SUB-07). Every change is audited in the school's log
 * (when it concerns a school) and in the platform log. Nothing is deleted: grants and access are ended once,
 * prices are archived.
 */

const UUID = z.string().uuid();
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");

async function platformEvent(tx: Transaction, actorUserId: string, action: string, metadata: object) {
  await tx
    .insert(platformEvents)
    .values({ actorUserId, action, metadata: metadata as Record<string, unknown> });
}

interface SchoolRow {
  id: string;
  name: string;
  timezone: string;
  isDemo: boolean;
  currencyCode: string;
}

async function readSchool(tx: Transaction, tenantId: string): Promise<SchoolRow> {
  const [school] = await tx
    .select({
      id: tenants.id,
      name: tenants.name,
      timezone: tenants.timezone,
      isDemo: tenants.isDemo,
      currencyCode: tenants.currencyCode,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!school) throw new DomainError("school_not_found", "School not found.");
  return school;
}

const lockModules = (tx: Transaction, tenantId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"school-modules:" + tenantId}, 0))`);

// ——— Granting and ending modules for a school ———

export const grantSchema = z
  .object({
    module: z.enum(PLAN_CHOICES as [PlanModuleId, ...PlanModuleId[]], { message: "Choose a module." }),
    source: z.enum(ENTITLEMENT_SOURCES, { message: "Choose why the school has it." }),
    startsOn: z.preprocess(blankToNull, isoDate.nullable().optional()),
    endsOn: z.preprocess(blankToNull, isoDate.nullable().optional()),
    price: z.preprocess(blankToNull, z.string().nullable().optional()),
    priceUnit: z.enum(["flat", "per_student"]).default("flat"),
    billingPeriod: z.preprocess(blankToNull, z.enum(BILLING_PERIODS).nullable().optional()),
    note: z.preprocess(
      blankToNull,
      z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional(),
    ),
  })
  .refine((v) => !v.endsOn || !v.startsOn || v.endsOn >= v.startsOn, {
    message: "The end must be on or after the start.",
    path: ["endsOn"],
  })
  .refine((v) => v.source !== "trial" || v.endsOn, {
    message: "A trial needs an end date.",
    path: ["endsOn"],
  });

export interface GrantInput {
  module: PlanModuleId;
  source: EntitlementSource;
  startsOn: string;
  endsOn: string | null;
  pricePesewas: number | null;
  priceUnit: "flat" | "per_student";
  billingPeriod: BillingPeriod | null;
  note: string | null;
}

/**
 * Inside the school's tenant transaction: adds a module for the school, after checking its dependencies
 * (MOD-03) and that no other grant of it overlaps. Shared by the admin page and approving a school's request.
 */
export async function grantModuleInTx(
  tx: Transaction,
  actorUserId: string,
  tenantId: string,
  input: GrantInput,
  reason: { requestId?: string } = {},
): Promise<{ id: string }> {
  const school = await readSchool(tx, tenantId);
  await lockModules(tx, tenantId);
  const states = await readModuleStates(tx, school);
  if (states[input.module]?.state === "active" && states[input.module]?.source === "plan")
    throw new DomainError(
      "module_in_plan",
      `${MODULES[input.module].name} is already in this school's plan.`,
    );
  const have = activeModules(states);
  const missing = missingDependencies(input.module, have);
  if (missing.length)
    throw new DomainError(
      "module_dependencies",
      `${MODULES[input.module].name} needs ${missing.map((m) => MODULES[m].name).join(" and ")} first.`,
      "module",
    );
  const open = await tx
    .select({ startsOn: schoolModules.startsOn, endsOn: schoolModules.endsOn })
    .from(schoolModules)
    .where(
      and(
        eq(schoolModules.tenantId, tenantId),
        eq(schoolModules.module, input.module),
        isNull(schoolModules.endedAt),
      ),
    );
  const overlaps = open.some(
    (g) =>
      (g.endsOn === null || g.endsOn >= input.startsOn) &&
      (input.endsOn === null || input.endsOn >= g.startsOn),
  );
  if (overlaps)
    throw new DomainError(
      "module_grant_overlap",
      `The school already has ${MODULES[input.module].name} for some of these dates. End that first.`,
      "module",
    );
  const priced = input.pricePesewas !== null;
  const [row] = await tx
    .insert(schoolModules)
    .values({
      tenantId,
      module: input.module,
      source: input.source,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      pricePesewas: input.pricePesewas,
      priceUnit: priced ? input.priceUnit : null,
      billingPeriod: priced ? (input.billingPeriod ?? "termly") : null,
      currencyCode: priced ? school.currencyCode : null,
      note: input.note,
      grantedByUserId: actorUserId,
    })
    .returning({ id: schoolModules.id });
  const metadata = {
    module: input.module,
    source: input.source,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    pricePesewas: input.pricePesewas,
    priceUnit: priced ? input.priceUnit : null,
    requestId: reason.requestId ?? null,
  };
  await recordAudit(tx, {
    tenantId,
    actorUserId,
    action: "modules.granted",
    entityType: "school_module",
    entityId: row!.id,
    metadata,
  });
  await platformEvent(tx, actorUserId, "modules.granted", { ...metadata, tenantId, school: school.name });
  return { id: row!.id };
}

export async function grantModule(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<{ id: string }> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(tenantId).success) throw new DomainError("school_not_found", "School not found.");
  const data = grantSchema.parse(input);
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const school = await readSchool(tx, tenantId);
    let pricePesewas: number | null = null;
    if (data.price !== null && data.price !== undefined) {
      pricePesewas = parseMoney(data.price, school.currencyCode);
      if (pricePesewas === null || pricePesewas > 1_000_000_000)
        throw new DomainError("price_invalid", "Enter the price, like 300 or 300.00.", "price");
    }
    return grantModuleInTx(tx, actorUserId, tenantId, {
      module: data.module,
      source: data.source,
      startsOn: data.startsOn ?? todayIn(school.timezone),
      endsOn: data.endsOn ?? null,
      pricePesewas,
      priceUnit: data.priceUnit,
      billingPeriod: data.billingPeriod ?? null,
      note: data.note ?? null,
    });
  });
}

/** Inside the school's tenant transaction: sets the last day of an open grant that has none (once). */
export async function scheduleModuleEndInTx(
  tx: Transaction,
  actorUserId: string,
  tenantId: string,
  grantId: string,
  endsOn: string,
  reason: { requestId?: string } = {},
): Promise<void> {
  const [grant] = await tx
    .select()
    .from(schoolModules)
    .where(and(eq(schoolModules.tenantId, tenantId), eq(schoolModules.id, grantId)))
    .for("update");
  if (!grant || grant.endedAt)
    throw new DomainError("module_grant_not_found", "This module is no longer open.");
  if (grant.endsOn) throw new DomainError("module_end_set", "This module already has an end date.");
  const last = endsOn < grant.startsOn ? grant.startsOn : endsOn;
  await tx.update(schoolModules).set({ endsOn: last }).where(eq(schoolModules.id, grant.id));
  const school = await readSchool(tx, tenantId);
  const metadata = { module: grant.module, endsOn: last, requestId: reason.requestId ?? null };
  await recordAudit(tx, {
    tenantId,
    actorUserId,
    action: "modules.end_scheduled",
    entityType: "school_module",
    entityId: grant.id,
    metadata,
  });
  await platformEvent(tx, actorUserId, "modules.end_scheduled", {
    ...metadata,
    tenantId,
    school: school.name,
  });
}

export async function scheduleModuleEnd(
  database: Database,
  actorUserId: string,
  tenantId: string,
  grantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(tenantId).success || !UUID.safeParse(grantId).success)
    throw new DomainError("module_grant_not_found", "This module is no longer open.");
  const { endsOn } = z.object({ endsOn: isoDate }).parse(input);
  await withTenant(database, { tenantId, userId: actorUserId }, (tx) =>
    scheduleModuleEndInTx(tx, actorUserId, tenantId, grantId, endsOn),
  );
}

/** Ends a grant now, with a reason. The module is read-only (R4 modules) or off from today; data is kept. */
export async function endModuleGrant(
  database: Database,
  actorUserId: string,
  tenantId: string,
  grantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(tenantId).success || !UUID.safeParse(grantId).success)
    throw new DomainError("module_grant_not_found", "This module is no longer open.");
  const { reason } = z
    .object({
      reason: z.string().trim().min(3, "Say why, for the record.").max(300, "Use 300 characters or fewer."),
    })
    .parse(input);
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const school = await readSchool(tx, tenantId);
    const ended = await tx
      .update(schoolModules)
      .set({ endedAt: new Date(), endedByUserId: actorUserId, endReason: reason })
      .where(
        and(
          eq(schoolModules.tenantId, tenantId),
          eq(schoolModules.id, grantId),
          isNull(schoolModules.endedAt),
        ),
      )
      .returning({ module: schoolModules.module });
    if (!ended.length) throw new DomainError("module_grant_not_found", "This module is no longer open.");
    const metadata = { module: ended[0]!.module, reason };
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action: "modules.ended",
      entityType: "school_module",
      entityId: grantId,
      metadata,
    });
    await platformEvent(tx, actorUserId, "modules.ended", { ...metadata, tenantId, school: school.name });
  });
}

// ——— Release access (REL-02) ———

const RELEASABLE = new Set(["internal_testing", "ready", "pilot"]);

export async function setReleaseAccess(
  database: Database,
  actorUserId: string,
  tenantId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(tenantId).success) throw new DomainError("school_not_found", "School not found.");
  const { module, on } = z
    .object({
      module: z.string().refine(isPlanModule, "Choose a module."),
      on: z.boolean(),
    })
    .parse(input);
  const id = module as PlanModuleId;
  if (on && !RELEASABLE.has(MODULES[id].stage))
    throw new DomainError(
      "module_not_releasable",
      MODULES[id].stage === "general"
        ? `${MODULES[id].name} is already available to every school that has it.`
        : `${MODULES[id].name} is not ready for schools yet.`,
      "module",
    );
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const school = await readSchool(tx, tenantId);
    await lockModules(tx, tenantId);
    if (on) {
      const inserted = await tx
        .insert(moduleReleaseAccess)
        .values({ tenantId, module: id, grantedByUserId: actorUserId })
        .onConflictDoNothing()
        .returning({ id: moduleReleaseAccess.id });
      if (!inserted.length) return;
    } else {
      const ended = await tx
        .update(moduleReleaseAccess)
        .set({ endedAt: new Date(), endedByUserId: actorUserId })
        .where(
          and(
            eq(moduleReleaseAccess.tenantId, tenantId),
            eq(moduleReleaseAccess.module, id),
            isNull(moduleReleaseAccess.endedAt),
          ),
        )
        .returning({ id: moduleReleaseAccess.id });
      if (!ended.length) return;
    }
    const action = on ? "modules.release_access_granted" : "modules.release_access_ended";
    await recordAudit(tx, {
      tenantId,
      actorUserId,
      action,
      entityType: "tenant",
      entityId: tenantId,
      metadata: { module: id },
    });
    await platformEvent(tx, actorUserId, action, { module: id, tenantId, school: school.name });
  });
}

// ——— A school's modules, for its admin page ———

export interface ModuleGrantRow {
  id: string;
  module: PlanModuleId;
  source: EntitlementSource;
  startsOn: string;
  endsOn: string | null;
  pricePesewas: number | null;
  priceUnit: "flat" | "per_student" | null;
  billingPeriod: BillingPeriod | null;
  currencyCode: string | null;
  note: string | null;
  grantedBy: string;
  grantedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

export interface SchoolModulesAdmin {
  today: string;
  states: Record<string, ModuleState>;
  planModules: string[] | null;
  grants: ModuleGrantRow[];
  releaseAccess: PlanModuleId[];
}

export async function grantRows(tx: Transaction, tenantId: string): Promise<ModuleGrantRow[]> {
  const rows = await tx
    .select({ g: schoolModules, by: users.name })
    .from(schoolModules)
    .innerJoin(users, eq(users.id, schoolModules.grantedByUserId))
    .where(eq(schoolModules.tenantId, tenantId))
    .orderBy(desc(schoolModules.grantedAt));
  return rows
    .filter(({ g }) => isPlanModule(g.module))
    .map(({ g, by }) => ({
      id: g.id,
      module: g.module as PlanModuleId,
      source: g.source,
      startsOn: g.startsOn,
      endsOn: g.endsOn,
      pricePesewas: g.pricePesewas,
      priceUnit: g.priceUnit,
      billingPeriod: g.billingPeriod,
      currencyCode: g.currencyCode,
      note: g.note,
      grantedBy: by,
      grantedAt: g.grantedAt,
      endedAt: g.endedAt,
      endReason: g.endReason,
    }));
}

export async function getSchoolModulesAdmin(
  database: Database,
  actorUserId: string,
  tenantId: string,
): Promise<SchoolModulesAdmin> {
  await assertPlatformAdmin(database, actorUserId);
  return withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const school = await readSchool(tx, tenantId);
    const [plan] = await tx
      .select({ features: tenantEntitlements.features })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId));
    const access = await tx
      .select({ module: moduleReleaseAccess.module })
      .from(moduleReleaseAccess)
      .where(and(eq(moduleReleaseAccess.tenantId, tenantId), isNull(moduleReleaseAccess.endedAt)));
    return {
      today: todayIn(school.timezone),
      states: await readModuleStates(tx, school),
      planModules: plan ? plan.features : null,
      grants: await grantRows(tx, tenantId),
      releaseAccess: access.map((a) => a.module).filter(isPlanModule),
    };
  });
}

// ——— The catalogue (SUB-07, SUB-10) ———

export interface CatalogPrice {
  id: string;
  presetId: string | null;
  module: PlanModuleId | null;
  billingPeriod: BillingPeriod;
  currencyCode: string;
  pricePesewas: number;
  unit: "flat" | "per_student";
}

export interface CatalogModule {
  id: PlanModuleId;
  /** Schools that have it now (plan or add-on), and schools with release access. */
  schools: number;
  releaseSchools: number;
  prices: CatalogPrice[];
}

export interface Catalog {
  modules: CatalogModule[];
  presetPrices: CatalogPrice[];
  readOnlyDays: number;
  events: { action: string; at: Date; by: string | null; metadata: Record<string, unknown> }[];
}

const toPrice = (p: typeof catalogPrices.$inferSelect): CatalogPrice => ({
  id: p.id,
  presetId: p.presetId,
  module: p.module && isPlanModule(p.module) ? p.module : null,
  billingPeriod: p.billingPeriod,
  currencyCode: p.currencyCode,
  pricePesewas: p.pricePesewas,
  unit: p.unit,
});

/** Current catalogue prices (not archived), for anyone: they carry no school data. */
export async function readCatalogPrices(tx: Transaction): Promise<CatalogPrice[]> {
  const rows = await tx
    .select()
    .from(catalogPrices)
    .where(isNull(catalogPrices.archivedAt))
    .orderBy(asc(catalogPrices.currencyCode), asc(catalogPrices.billingPeriod));
  return rows.map(toPrice);
}

export async function getCatalog(database: Database, actorUserId: string): Promise<Catalog> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const prices = await readCatalogPrices(tx);
    // Platform administrators can read every school's plan and add-ons (RLS).
    const plans = await tx.select({ features: tenantEntitlements.features }).from(tenantEntitlements);
    const today = new Date().toISOString().slice(0, 10);
    const grants = await tx
      .select({
        tenantId: schoolModules.tenantId,
        module: schoolModules.module,
        endsOn: schoolModules.endsOn,
      })
      .from(schoolModules)
      .where(and(isNull(schoolModules.endedAt), sql`${schoolModules.startsOn} <= ${today}`));
    const access = await tx
      .select({ module: moduleReleaseAccess.module })
      .from(moduleReleaseAccess)
      .where(isNull(moduleReleaseAccess.endedAt));
    const [settings] = await tx
      .select({ readOnlyDays: platformSettings.moduleReadOnlyDays })
      .from(platformSettings)
      .limit(1);
    const events = await tx
      .select({ e: platformEvents, by: users.name })
      .from(platformEvents)
      .leftJoin(users, eq(users.id, platformEvents.actorUserId))
      .where(sql`${platformEvents.action} like 'modules.%' or ${platformEvents.action} like 'catalog.%'`)
      .orderBy(desc(platformEvents.occurredAt))
      .limit(30);
    return {
      modules: PLAN_CHOICES.map((id) => ({
        id,
        schools:
          plans.filter((p) => p.features.includes(id)).length +
          new Set(
            grants
              .filter((g) => g.module === id && (g.endsOn === null || g.endsOn >= today))
              .map((g) => g.tenantId),
          ).size,
        releaseSchools: access.filter((a) => a.module === id).length,
        prices: prices.filter((p) => p.module === id),
      })),
      presetPrices: prices.filter((p) => p.presetId !== null),
      readOnlyDays: settings?.readOnlyDays ?? 90,
      events: events.map(({ e, by }) => ({ action: e.action, at: e.occurredAt, by, metadata: e.metadata })),
    };
  });
}

const priceSchema = z
  .object({
    presetId: z.preprocess(blankToNull, UUID.nullable().optional()),
    module: z.preprocess(
      blankToNull,
      z.string().refine(isPlanModule, "Choose a module.").nullable().optional(),
    ),
    billingPeriod: z.enum(BILLING_PERIODS, { message: "Choose how often schools pay." }),
    currencyCode: z.string().regex(/^[A-Z]{3}$/, "Choose a currency."),
    price: z.string().trim().min(1, "Enter the price."),
    unit: z.enum(["flat", "per_student"], { message: "Choose how the price is counted." }),
  })
  .refine((v) => Boolean(v.presetId) !== Boolean(v.module), {
    message: "Choose a plan or a module.",
    path: ["module"],
  });

/** Sets a catalogue price (archiving the one it replaces, so the history is kept). */
export async function setCatalogPrice(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = priceSchema.parse(input);
  const pricePesewas = parseMoney(data.price, data.currencyCode);
  if (pricePesewas === null || pricePesewas > 1_000_000_000)
    throw new DomainError("price_invalid", "Enter the price, like 300 or 300.00.", "price");
  await withUser(database, actorUserId, async (tx) => {
    if (data.presetId) {
      const [preset] = await tx
        .select({ id: planPresets.id })
        .from(planPresets)
        .where(eq(planPresets.id, data.presetId));
      if (!preset) throw new DomainError("preset_not_found", "Plan not found.", "presetId");
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('catalog-prices', 0))`);
    const owner = data.presetId
      ? eq(catalogPrices.presetId, data.presetId)
      : eq(catalogPrices.module, data.module!);
    await tx
      .update(catalogPrices)
      .set({ archivedAt: new Date() })
      .where(
        and(
          owner,
          eq(catalogPrices.billingPeriod, data.billingPeriod),
          eq(catalogPrices.currencyCode, data.currencyCode),
          isNull(catalogPrices.archivedAt),
        ),
      );
    await tx.insert(catalogPrices).values({
      presetId: data.presetId ?? null,
      module: data.module ?? null,
      billingPeriod: data.billingPeriod,
      currencyCode: data.currencyCode,
      pricePesewas,
      unit: data.unit,
      createdByUserId: actorUserId,
    });
    await platformEvent(tx, actorUserId, "catalog.price_set", {
      presetId: data.presetId ?? null,
      module: data.module ?? null,
      billingPeriod: data.billingPeriod,
      currencyCode: data.currencyCode,
      pricePesewas,
      unit: data.unit,
    });
  });
}

export async function archiveCatalogPrice(
  database: Database,
  actorUserId: string,
  priceId: string,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(priceId).success) throw new DomainError("price_not_found", "Price not found.");
  await withUser(database, actorUserId, async (tx) => {
    const archived = await tx
      .update(catalogPrices)
      .set({ archivedAt: new Date() })
      .where(and(eq(catalogPrices.id, priceId), isNull(catalogPrices.archivedAt)))
      .returning();
    if (!archived.length) throw new DomainError("price_not_found", "Price not found.");
    await platformEvent(tx, actorUserId, "catalog.price_archived", { priceId, ...toPrice(archived[0]!) });
  });
}

export async function setReadOnlyDays(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const { days } = z
    .object({
      days: z.coerce
        .number()
        .int("Use a whole number.")
        .min(0, "Use 0 or more.")
        .max(365, "Use 365 or fewer."),
    })
    .parse(input);
  await withUser(database, actorUserId, async (tx) => {
    await tx
      .update(platformSettings)
      .set({ moduleReadOnlyDays: days, updatedAt: new Date(), updatedByUserId: actorUserId })
      .where(eq(platformSettings.id, true));
    await platformEvent(tx, actorUserId, "modules.read_only_days_set", { days });
  });
}

/** Whether a module can be reached by this school now (release only; entitlement is separate). */
export function releasedToSchool(
  id: PlanModuleId,
  school: { isDemo: boolean; releaseAccess: readonly string[] },
): boolean {
  return isReleasedTo(MODULES[id].stage, {
    hasAccess: school.releaseAccess.includes(id),
    isDemo: school.isDemo,
    production: process.env.NODE_ENV === "production",
  });
}
