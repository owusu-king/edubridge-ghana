import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseMoney } from "../../lib/money";
import {
  BILLING_PERIODS,
  FEATURES,
  isFeature,
  type BillingPeriod,
  type Feature,
  type PlanRequestStatus,
} from "../../lib/plan";
import { todayIn } from "../../lib/format";
import { ADD_ON_CHOICES, MODULES, isPlanModule, type PlanModuleId } from "../../lib/modules";
import {
  SIZE_BANDS,
  SUGGESTED_ADD_ONS,
  SUGGESTED_PLANS,
  bandsFromCedis,
  validBands,
  type PriceBand,
} from "../../lib/pricing";
import { recordAudit } from "../audit/record";
import {
  grantModuleInTx,
  grantRows,
  readCatalogPrices,
  releasedToSchool,
  scheduleModuleEndInTx,
  type CatalogPrice,
  type ModuleGrantRow,
} from "../entitlements/admin";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant, withUser } from "../db/context";
import {
  catalogPrices,
  memberships,
  moduleReleaseAccess,
  planChangeRequests,
  planPresets,
  platformAdmins,
  tenantEntitlements,
  tenants,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { enqueue } from "../notifications/outbox";
import { assertPlatformAdmin } from "../platform/service";
import { presetValues, readPreset } from "./preset-values";
import type { TenantContext } from "../tenancy/service";

/**
 * Plan presets (SUB-01) and plan change requests (SUB-02, D-R3-4). Presets are EduBridge's plans; a school's
 * plan is a copy of one (tenant_entitlements), so editing a preset never changes a school already on it.
 * Schools ask for a change and platform staff approve or decline it: no school changes its own plan while
 * prices are being validated (`13` C-01).
 */

const UUID = z.string().uuid();
const optionalLimit = (min: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
    z
      .number()
      .int("Use a whole number.")
      .min(min, `Use ${min} or more.`)
      .max(1_000_000, "Too large.")
      .nullable(),
  );

const presetSchema = z.object({
  name: z.string().trim().min(2, "Name the plan.").max(60, "Use 60 characters or fewer."),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional(),
  ),
  features: z.array(z.enum(FEATURES)).default([]),
  maxCampuses: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(1000, "Use 1000 or fewer."),
  maxStudents: optionalLimit(1),
  maxSmsPerMonth: optionalLimit(0),
  billingPeriod: z.enum(BILLING_PERIODS, { message: "Choose how often schools pay." }),
  currencyCode: z.string().regex(/^[A-Z]{3}$/, "Choose a currency."),
  price: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().optional()),
  /** Price per term for each size band (band0 is the smallest); all empty: priced per school. */
  ...Object.fromEntries(
    SIZE_BANDS.map((_, i) => [
      `band${i}`,
      z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().optional()),
    ]),
  ),
});

function parsePreset(input: unknown) {
  const data = presetSchema.parse(input) as z.infer<typeof presetSchema> & Record<string, string | undefined>;
  let pricePesewas: number | null = null;
  if (data.price !== undefined) {
    pricePesewas = parseMoney(data.price, data.currencyCode);
    if (pricePesewas === null || pricePesewas > 1_000_000_000)
      throw new DomainError("price_invalid", "Enter the price, like 1500 or 1500.00.", "price");
  }
  const typed = SIZE_BANDS.map((_, i) => data[`band${i}`]);
  let priceBands: PriceBand[] | null = null;
  if (typed.some((t) => t !== undefined)) {
    priceBands = SIZE_BANDS.map((upTo, i) => {
      const minor = typed[i] === undefined ? null : parseMoney(typed[i]!, data.currencyCode);
      if (minor === null || minor <= 0 || minor > 1_000_000_000)
        throw new DomainError("price_invalid", "Enter a price for every size, like 1500.", `band${i}`);
      return { upTo, termlyMinor: minor };
    });
    if (!validBands(priceBands))
      throw new DomainError("price_invalid", "A larger school cannot pay less than a smaller one.", "band1");
  }
  const {
    name,
    description,
    features,
    maxCampuses,
    maxStudents,
    maxSmsPerMonth,
    billingPeriod,
    currencyCode,
  } = data;
  return {
    name,
    description: description ?? null,
    features,
    maxCampuses,
    maxStudents,
    maxSmsPerMonth,
    billingPeriod,
    currencyCode,
    pricePesewas,
    priceBands,
  };
}

export interface PlanPreset {
  id: string;
  name: string;
  description: string | null;
  features: Feature[];
  maxCampuses: number;
  maxStudents: number | null;
  maxSmsPerMonth: number | null;
  billingPeriod: BillingPeriod;
  pricePesewas: number | null;
  /** Price per term by school size; null when priced per school. */
  priceBands: PriceBand[] | null;
  currencyCode: string;
  archived: boolean;
  /** Schools whose plan was last set from it. */
  schools: number;
}

const toPreset = (r: typeof planPresets.$inferSelect, schools = 0): PlanPreset => ({
  id: r.id,
  name: r.name,
  description: r.description,
  features: r.features.filter(isFeature),
  maxCampuses: r.maxCampuses,
  maxStudents: r.maxStudents,
  maxSmsPerMonth: r.maxSmsPerMonth,
  billingPeriod: r.billingPeriod,
  pricePesewas: r.pricePesewas,
  priceBands: r.priceBands,
  currencyCode: r.currencyCode,
  archived: r.archivedAt !== null,
  schools,
});

/** Every preset, archived last, with how many schools are on each (platform staff). */
export async function listPresets(database: Database, actorUserId: string): Promise<PlanPreset[]> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const rows = await tx
      .select({
        p: planPresets,
        schools: sql<number>`(select count(*)::int from ${tenantEntitlements} e where e.plan_preset_id = ${planPresets.id})`,
      })
      .from(planPresets)
      .orderBy(sql`${planPresets.archivedAt} is not null`, asc(planPresets.name));
    return rows.map((r) => toPreset(r.p, r.schools));
  });
}

const nameTaken = () => new DomainError("preset_name_taken", "Another plan already has this name.", "name");
const isUnique = (error: unknown) =>
  (error as { code?: string; cause?: { code?: string } }).code === "23505" ||
  (error as { cause?: { code?: string } }).cause?.code === "23505";

export async function createPreset(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<{ id: string }> {
  await assertPlatformAdmin(database, actorUserId);
  const data = parsePreset(input);
  try {
    return await withUser(database, actorUserId, async (tx) => {
      const [row] = await tx
        .insert(planPresets)
        .values({ ...data, createdByUserId: actorUserId })
        .returning({ id: planPresets.id });
      return { id: row!.id };
    });
  } catch (error) {
    if (isUnique(error)) throw nameTaken();
    throw error;
  }
}

/** Changing a preset changes only schools set from it later; schools on it keep their plan. */
export async function updatePreset(
  database: Database,
  actorUserId: string,
  presetId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = parsePreset(input);
  if (!UUID.safeParse(presetId).success) throw new DomainError("preset_not_found", "Plan not found.");
  try {
    await withUser(database, actorUserId, async (tx) => {
      const updated = await tx
        .update(planPresets)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(planPresets.id, presetId))
        .returning({ id: planPresets.id });
      if (!updated.length) throw new DomainError("preset_not_found", "Plan not found.");
    });
  } catch (error) {
    if (isUnique(error)) throw nameTaken();
    throw error;
  }
}

/** Archived presets are no longer offered to schools or for new schools; schools on one keep their plan. */
export async function setPresetArchived(
  database: Database,
  actorUserId: string,
  presetId: string,
  archived: boolean,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(presetId).success) throw new DomainError("preset_not_found", "Plan not found.");
  await withUser(database, actorUserId, (tx) =>
    tx
      .update(planPresets)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(planPresets.id, presetId)),
  );
}

/**
 * Adds the suggested plans (Starter, Standard, Premium, priced per term by school size in Ghana cedis) and the
 * add-ons' termly catalogue prices (founder, 2026-11-18). Anything already there by name or module is left as
 * it is, so it can be run again. The prices are starting points, changed on the Plans and Modules pages.
 */
export async function addSuggestedPlans(
  database: Database,
  actorUserId: string,
): Promise<{ plans: number; prices: number }> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const existing = new Set(
      (await tx.select({ name: planPresets.name }).from(planPresets)).map((p) => p.name.toLowerCase()),
    );
    let plans = 0;
    for (const plan of SUGGESTED_PLANS) {
      if (existing.has(plan.name.toLowerCase())) continue;
      await tx.insert(planPresets).values({
        name: plan.name,
        description: plan.description,
        features: plan.features,
        maxCampuses: plan.maxCampuses,
        maxStudents: null,
        maxSmsPerMonth: plan.maxSmsPerMonth,
        billingPeriod: "termly",
        pricePesewas: null,
        priceBands: bandsFromCedis(plan.termlyCedis),
        currencyCode: "GHS",
        createdByUserId: actorUserId,
      });
      plans++;
    }
    const priced = new Set(
      (
        await tx
          .select({ module: catalogPrices.module })
          .from(catalogPrices)
          .where(
            and(
              isNull(catalogPrices.archivedAt),
              isNull(catalogPrices.presetId),
              eq(catalogPrices.billingPeriod, "termly"),
              eq(catalogPrices.currencyCode, "GHS"),
            ),
          )
      ).map((r) => r.module),
    );
    let prices = 0;
    for (const addOn of SUGGESTED_ADD_ONS) {
      if (priced.has(addOn.module)) continue;
      await tx.insert(catalogPrices).values({
        module: addOn.module,
        billingPeriod: "termly",
        currencyCode: "GHS",
        pricePesewas: Math.round(addOn.termlyCedis * 100),
        unit: "flat",
        createdByUserId: actorUserId,
      });
      prices++;
    }
    return { plans, prices };
  });
}

/** Inside the school's tenant transaction (platform staff): sets its plan from a preset, audited. */
async function applyPresetInTx(
  tx: Transaction,
  actorUserId: string,
  tenantId: string,
  preset: typeof planPresets.$inferSelect,
  reason: { requestId?: string } = {},
) {
  const [school] = await tx
    .select({ currency: tenants.currencyCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!school) throw new DomainError("school_not_found", "School not found.");
  const [before] = await tx
    .select()
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  const values = presetValues(preset, school.currency);
  await tx
    .insert(tenantEntitlements)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: tenantEntitlements.tenantId, set: { ...values, updatedAt: new Date() } });
  await recordAudit(tx, {
    tenantId,
    actorUserId,
    action: "entitlements.preset_applied",
    entityType: "tenant",
    entityId: tenantId,
    metadata: {
      preset: preset.name,
      presetId: preset.id,
      requestId: reason.requestId ?? null,
      from: before
        ? {
            planName: before.planName,
            features: before.features,
            maxCampuses: before.maxCampuses,
            maxStudents: before.maxStudents,
            maxSmsPerMonth: before.maxSmsPerMonth,
            pricePesewas: before.pricePesewas,
          }
        : null,
      to: values,
    },
  });
}

/** Platform staff set a school's plan from a preset (its own page). */
export async function applyPreset(
  database: Database,
  actorUserId: string,
  tenantId: string,
  presetId: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  if (!UUID.safeParse(tenantId).success) throw new DomainError("school_not_found", "School not found.");
  await withTenant(database, { tenantId, userId: actorUserId }, async (tx) => {
    const preset = await readPreset(tx, String(presetId ?? ""), { offered: true });
    if (!preset) throw new DomainError("preset_not_found", "Choose a plan.", "presetId");
    await applyPresetInTx(tx, actorUserId, tenantId, preset);
  });
}

// ——— Plan change requests ———

export interface PlanRequestRow {
  id: string;
  /** What is asked for (SUB-08): another plan, a module added, or an add-on cancelled. */
  kind: "plan" | "add_module" | "cancel_module";
  module: PlanModuleId | null;
  presetName: string | null;
  message: string | null;
  status: PlanRequestStatus;
  requestedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}

export interface OfferedPlan {
  id: string;
  name: string;
  description: string | null;
  features: Feature[];
  maxCampuses: number;
  maxStudents: number | null;
  maxSmsPerMonth: number | null;
  current: boolean;
}

/** A module the school can ask EduBridge to add (SUB-08), with the catalogue prices in its currency. */
export interface AvailableModule {
  id: PlanModuleId;
  prices: CatalogPrice[];
}

export interface SchoolPlanOptions {
  /** Presets offered (no prices: EduBridge confirms the price with the school). */
  plans: OfferedPlan[];
  /** The school's add-ons, trials, promotions and agreements, newest first. */
  grants: ModuleGrantRow[];
  /** Modules the school does not have that it can ask for. */
  available: AvailableModule[];
  pending: PlanRequestRow | null;
  history: PlanRequestRow[];
  canRequest: boolean;
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

async function requestRows(tx: Transaction, where: ReturnType<typeof and>, limit: number) {
  const rows = await tx
    .select({ r: planChangeRequests, presetName: planPresets.name, by: users.name })
    .from(planChangeRequests)
    .leftJoin(planPresets, eq(planPresets.id, planChangeRequests.presetId))
    .innerJoin(users, eq(users.id, planChangeRequests.requestedByUserId))
    .where(where)
    .orderBy(desc(planChangeRequests.createdAt))
    .limit(limit);
  return rows.map(({ r, presetName, by }) => ({
    id: r.id,
    tenantId: r.tenantId,
    kind: r.kind,
    module: r.module && isPlanModule(r.module) ? r.module : null,
    presetName,
    message: r.message,
    status: r.status,
    requestedBy: by,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
  }));
}

/** For Settings, Plan: the plans EduBridge offers, and this school's requests. */
export async function getPlanOptions(database: Database, ctx: TenantContext): Promise<SchoolPlanOptions> {
  assertAllowed(ctx, "plan.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const [plan] = await tx
      .select({ presetId: tenantEntitlements.planPresetId })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, ctx.tenant.id));
    const presets = await tx
      .select()
      .from(planPresets)
      .where(isNull(planPresets.archivedAt))
      .orderBy(asc(planPresets.maxCampuses), asc(planPresets.name));
    const history = await requestRows(tx, and(eq(planChangeRequests.tenantId, ctx.tenant.id)), 10);
    const access = await tx
      .select({ module: moduleReleaseAccess.module })
      .from(moduleReleaseAccess)
      .where(and(eq(moduleReleaseAccess.tenantId, ctx.tenant.id), isNull(moduleReleaseAccess.endedAt)));
    const prices = (await readCatalogPrices(tx)).filter((p) => p.currencyCode === ctx.tenant.currencyCode);
    const school = { isDemo: ctx.tenant.isDemo, releaseAccess: access.map((a) => a.module) };
    return {
      grants: await grantRows(tx, ctx.tenant.id),
      available: ADD_ON_CHOICES.filter(
        (id) => ctx.modules[id]?.state !== "active" && releasedToSchool(id, school),
      ).map((id) => ({ id, prices: prices.filter((p) => p.module === id) })),
      plans: presets.map((p) => {
        const {
          pricePesewas: _price,
          currencyCode: _currency,
          billingPeriod: _period,
          archived: _a,
          schools: _s,
          ...shown
        } = toPreset(p);
        return { ...shown, current: p.id === plan?.presetId };
      }),
      pending: history.find((r) => r.status === "pending") ?? null,
      history: history.filter((r) => r.status !== "pending"),
      canRequest: allowed(ctx, "plan.request"),
    };
  });
}

const requestSchema = z
  .object({
    kind: z.enum(["plan", "add_module", "cancel_module"]).default("plan"),
    module: z.preprocess(
      (v) => (v === "" || v === undefined ? null : v),
      z.string().refine(isPlanModule, "Choose a module.").nullable(),
    ),
    presetId: z.preprocess((v) => (v === "" || v === undefined ? null : v), UUID.nullable()),
    message: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(500, "Use 500 characters or fewer.").nullable().optional(),
    ),
  })
  .refine((v) => v.kind !== "plan" || v.presetId || v.message, {
    message: "Choose a plan or say what you need.",
    path: ["message"],
  })
  .refine((v) => v.kind === "plan" || v.module, { message: "Choose a module.", path: ["module"] });

/** The Proprietor asks EduBridge for a plan change. One request waits at a time; platform staff are emailed. */
export async function requestPlanChange(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string }> {
  assertAllowed(ctx, "plan.request");
  const data = requestSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"plan-request:" + ctx.tenant.id}, 0))`,
    );
    const [waiting] = await tx
      .select({ id: planChangeRequests.id })
      .from(planChangeRequests)
      .where(and(eq(planChangeRequests.tenantId, ctx.tenant.id), eq(planChangeRequests.status, "pending")));
    if (waiting)
      throw new DomainError(
        "plan_request_pending",
        "Your school already has a request waiting. Withdraw it to ask for something else.",
      );
    const moduleId = data.kind === "plan" ? null : (data.module as PlanModuleId);
    if (data.kind === "add_module") {
      const access = await tx
        .select({ module: moduleReleaseAccess.module })
        .from(moduleReleaseAccess)
        .where(and(eq(moduleReleaseAccess.tenantId, ctx.tenant.id), isNull(moduleReleaseAccess.endedAt)));
      const offered =
        ADD_ON_CHOICES.includes(moduleId!) &&
        releasedToSchool(moduleId!, {
          isDemo: ctx.tenant.isDemo,
          releaseAccess: access.map((a) => a.module),
        });
      if (!offered) throw new DomainError("module_not_offered", "This module is not offered yet.", "module");
      if (ctx.modules[moduleId!]?.state === "active")
        throw new DomainError(
          "module_active",
          `Your school already has ${MODULES[moduleId!].name}.`,
          "module",
        );
    }
    if (data.kind === "cancel_module") {
      const open = (await grantRows(tx, ctx.tenant.id)).find(
        (g) => g.module === moduleId && !g.endedAt && g.endsOn === null,
      );
      if (!open)
        throw new DomainError(
          "module_not_cancellable",
          "Only an add-on without an end date can be cancelled this way. Modules in your plan change with the plan.",
          "module",
        );
    }
    const preset =
      data.kind === "plan" && data.presetId ? await readPreset(tx, data.presetId, { offered: true }) : null;
    if (data.kind === "plan" && data.presetId && !preset)
      throw new DomainError("preset_not_found", "Choose one of the plans offered.", "presetId");
    const [row] = await tx
      .insert(planChangeRequests)
      .values({
        tenantId: ctx.tenant.id,
        kind: data.kind,
        module: moduleId,
        presetId: preset?.id ?? null,
        message: data.message ?? null,
        requestedByUserId: ctx.userId,
      })
      .returning({ id: planChangeRequests.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "plan_change.requested",
      entityType: "plan_change_request",
      entityId: row!.id,
      metadata: {
        kind: data.kind,
        module: moduleId,
        preset: preset?.name ?? null,
        message: data.message ?? null,
      },
    });
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId));
    const asked =
      data.kind === "add_module"
        ? `to add ${MODULES[moduleId!].name}`
        : data.kind === "cancel_module"
          ? `to cancel ${MODULES[moduleId!].name}`
          : preset
            ? `the ${preset.name} plan`
            : null;
    const what = [asked, data.message ? `"${data.message}"` : null].filter(Boolean).join(", with the note ");
    const admins = await tx
      .select({ email: users.email })
      .from(platformAdmins)
      .innerJoin(users, eq(users.id, platformAdmins.userId));
    for (const admin of admins)
      await enqueue(tx, {
        channel: "email",
        recipient: admin.email,
        template: "plan_change_requested",
        payload: {
          schoolName: ctx.tenant.name,
          tenantId: ctx.tenant.id,
          requestedBy: me?.name ?? "A Proprietor",
          what,
        },
        idempotencyKey: `plan-request:${row!.id}`,
      });
    return { id: row!.id };
  });
}

export async function withdrawPlanRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
): Promise<void> {
  assertAllowed(ctx, "plan.request");
  if (!UUID.safeParse(requestId).success)
    throw new DomainError("plan_request_not_found", "Request not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const updated = await tx
      .update(planChangeRequests)
      .set({ status: "withdrawn", decidedAt: new Date(), decidedByUserId: ctx.userId })
      .where(
        and(
          eq(planChangeRequests.tenantId, ctx.tenant.id),
          eq(planChangeRequests.id, requestId),
          eq(planChangeRequests.status, "pending"),
        ),
      )
      .returning({ id: planChangeRequests.id });
    if (!updated.length)
      throw new DomainError("plan_request_not_found", "This request is no longer waiting.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "plan_change.withdrawn",
      entityType: "plan_change_request",
      entityId: requestId,
    });
  });
}

export interface PendingPlanRequest extends PlanRequestRow {
  tenantId: string;
  schoolName: string;
  currentPlan: string;
}

/** Every school's waiting request, oldest first (platform staff). */
export async function listPendingPlanRequests(
  database: Database,
  actorUserId: string,
): Promise<PendingPlanRequest[]> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const rows = (await requestRows(tx, and(eq(planChangeRequests.status, "pending")), 200)).reverse();
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.tenantId))];
    const schools = await tx
      .select({ id: tenants.id, name: tenants.name, plan: tenantEntitlements.planName })
      .from(tenants)
      .leftJoin(tenantEntitlements, eq(tenantEntitlements.tenantId, tenants.id))
      .where(inArray(tenants.id, ids));
    const byId = new Map(schools.map((s) => [s.id, s]));
    return rows.map((r) => ({
      ...r,
      schoolName: byId.get(r.tenantId)?.name ?? "A school",
      currentPlan: byId.get(r.tenantId)?.plan ?? "Pilot",
    }));
  });
}

const decisionSchema = z
  .object({
    approve: z.boolean(),
    note: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().max(300, "Use 300 characters or fewer.").nullable().optional(),
    ),
  })
  .refine((v) => v.approve || v.note, { message: "Say why, for the school.", path: ["note"] });

/**
 * Platform staff decide a request, once. Approving a request for a preset sets the school's plan from it in
 * the same transaction; a request with only a note is approved once staff have made the change by hand.
 * The member who asked is emailed.
 */
export async function decidePlanRequest(
  database: Database,
  actorUserId: string,
  requestId: string,
  input: unknown,
): Promise<{ applied: boolean }> {
  await assertPlatformAdmin(database, actorUserId);
  const data = decisionSchema.parse(input);
  if (!UUID.safeParse(requestId).success)
    throw new DomainError("plan_request_not_found", "Request not found.");
  const [found] = await withUser(database, actorUserId, (tx) =>
    tx
      .select({ tenantId: planChangeRequests.tenantId })
      .from(planChangeRequests)
      .where(eq(planChangeRequests.id, requestId)),
  );
  if (!found) throw new DomainError("plan_request_not_found", "Request not found.");
  return withTenant(database, { tenantId: found.tenantId, userId: actorUserId }, async (tx) => {
    const [request] = await tx
      .select()
      .from(planChangeRequests)
      .where(and(eq(planChangeRequests.tenantId, found.tenantId), eq(planChangeRequests.id, requestId)))
      .for("update");
    if (!request || request.status !== "pending")
      throw new DomainError("plan_request_decided", "This request was already decided or withdrawn.");
    const preset =
      request.presetId && data.approve ? await readPreset(tx, request.presetId, { offered: false }) : null;
    if (preset) await applyPresetInTx(tx, actorUserId, found.tenantId, preset, { requestId });
    let applied = Boolean(preset);
    if (data.approve && request.module && isPlanModule(request.module))
      applied = await applyModuleRequest(
        tx,
        actorUserId,
        found.tenantId,
        request.kind,
        request.module,
        requestId,
      );
    await tx
      .update(planChangeRequests)
      .set({
        status: data.approve ? "approved" : "declined",
        decidedAt: new Date(),
        decidedByUserId: actorUserId,
        decisionNote: data.note ?? null,
      })
      .where(eq(planChangeRequests.id, request.id));
    await recordAudit(tx, {
      tenantId: found.tenantId,
      actorUserId,
      action: data.approve ? "plan_change.approved" : "plan_change.declined",
      entityType: "plan_change_request",
      entityId: request.id,
      metadata: {
        preset: preset?.name ?? null,
        kind: request.kind,
        module: request.module,
        note: data.note ?? null,
      },
    });
    const [school] = await tx
      .select({ name: tenants.name, slug: tenants.slug, plan: tenantEntitlements.planName })
      .from(tenants)
      .leftJoin(tenantEntitlements, eq(tenantEntitlements.tenantId, tenants.id))
      .where(eq(tenants.id, found.tenantId));
    const [asker] = await tx
      .select({ email: users.email })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.tenantId, found.tenantId)))
      .where(and(eq(users.id, request.requestedByUserId), eq(memberships.status, "active")));
    if (asker && school)
      await enqueue(tx, {
        channel: "email",
        recipient: asker.email,
        template: "plan_change_decided",
        payload: {
          schoolName: school.name,
          schoolSlug: school.slug,
          approved: data.approve,
          planName: school.plan ?? "Pilot",
          note: data.note ?? null,
          what:
            request.module && isPlanModule(request.module)
              ? `${request.kind === "cancel_module" ? "cancel" : "add"} ${MODULES[request.module].name}`
              : null,
        },
        idempotencyKey: `plan-decision:${request.id}`,
      });
    return { applied };
  });
}

/**
 * Approving a module request (SUB-08): an add-on starts today at the catalogue price for the school's billing
 * period and currency (staff can end it and add another with a negotiated price); a cancellation ends the
 * add-on at the end of the period the school has paid for, or today.
 */
async function applyModuleRequest(
  tx: Transaction,
  actorUserId: string,
  tenantId: string,
  kind: "plan" | "add_module" | "cancel_module",
  module: PlanModuleId,
  requestId: string,
): Promise<boolean> {
  const [school] = await tx
    .select({
      timezone: tenants.timezone,
      currency: tenants.currencyCode,
      period: tenantEntitlements.billingPeriod,
      paidUntil: tenantEntitlements.paidUntil,
    })
    .from(tenants)
    .leftJoin(tenantEntitlements, eq(tenantEntitlements.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId));
  if (!school) throw new DomainError("school_not_found", "School not found.");
  const today = todayIn(school.timezone);
  if (kind === "add_module") {
    const period = school.period ?? "termly";
    const price = (await readCatalogPrices(tx)).find(
      (p) => p.module === module && p.billingPeriod === period && p.currencyCode === school.currency,
    );
    await grantModuleInTx(
      tx,
      actorUserId,
      tenantId,
      {
        module,
        source: "addon",
        startsOn: today,
        endsOn: null,
        pricePesewas: price?.pricePesewas ?? null,
        priceUnit: price?.unit ?? "flat",
        billingPeriod: price ? period : null,
        note: "Requested by the school.",
      },
      { requestId },
    );
    return true;
  }
  if (kind === "cancel_module") {
    const open = (await grantRows(tx, tenantId)).find(
      (g) => g.module === module && !g.endedAt && g.endsOn === null,
    );
    if (!open) return false;
    const endsOn = school.paidUntil && school.paidUntil > today ? school.paidUntil : today;
    await scheduleModuleEndInTx(tx, actorUserId, tenantId, open.id, endsOn, { requestId });
    return true;
  }
  return false;
}
