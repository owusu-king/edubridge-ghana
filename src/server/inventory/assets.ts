import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  ASSET_CONDITIONS,
  assetTag,
  CONDITION_LABELS,
  type AssetCondition,
  type AssetEventKind,
} from "../../lib/inventory";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { assetEvents, assets, inventorySuppliers, memberships, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { audit, blank, nextNumber, optionalMoney, optionalText, requiredText, scopeOf, UUID } from "./common";

/**
 * The asset register (R4-6 INV-01c). Each asset has a tag from a per-school counter, never reused. Its location,
 * custodian and condition are its current state; every change is also an insert-only event, so its history is
 * never lost. A disposed asset never changes again (database).
 */

export interface Asset {
  id: string;
  tag: string;
  name: string;
  category: string | null;
  serialNumber: string | null;
  location: string | null;
  custodianMembershipId: string | null;
  custodian: string | null;
  condition: AssetCondition;
  acquiredOn: string | null;
  costMinor: number | null;
  supplierId: string | null;
  supplier: string | null;
  note: string | null;
  status: "active" | "disposed";
  disposedAt: Date | null;
  disposalReason: string | null;
}

const custodianUser = alias(users, "custodian_user");

const assetColumns = {
  id: assets.id,
  tag: assets.tag,
  name: assets.name,
  category: assets.category,
  serialNumber: assets.serialNumber,
  location: assets.location,
  custodianMembershipId: assets.custodianMembershipId,
  custodian: sql<string | null>`coalesce(${custodianUser.name}, ${assets.custodianName})`,
  condition: assets.condition,
  acquiredOn: assets.acquiredOn,
  costMinor: assets.costMinor,
  supplierId: assets.supplierId,
  supplier: inventorySuppliers.name,
  note: assets.note,
  status: assets.status,
  disposedAt: assets.disposedAt,
  disposalReason: assets.disposalReason,
};

function selectAssets(tx: Transaction) {
  return tx
    .select(assetColumns)
    .from(assets)
    .leftJoin(memberships, eq(memberships.id, assets.custodianMembershipId))
    .leftJoin(custodianUser, eq(custodianUser.id, memberships.userId))
    .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, assets.supplierId));
}

export async function listAssets(database: Database, ctx: TenantContext): Promise<Asset[]> {
  assertAllowed(ctx, "inventory.view");
  return withTenant(database, scopeOf(ctx), (tx) =>
    selectAssets(tx).where(eq(assets.tenantId, ctx.tenant.id)).orderBy(asc(assets.status), asc(assets.tag)),
  );
}

/** Active assets, for the asset on a maintenance report (any member of staff). */
export async function listAssetChoices(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "maintenance.report");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: assets.id, tag: assets.tag, name: assets.name, location: assets.location })
      .from(assets)
      .where(and(eq(assets.tenantId, ctx.tenant.id), eq(assets.status, "active")))
      .orderBy(asc(assets.tag)),
  );
}

/** Active members who can be custodians. */
export async function listCustodianOptions(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "inventory.manage");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, "active"),
          sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
        ),
      )
      .orderBy(asc(users.name)),
  );
}

export interface AssetEvent {
  id: string;
  kind: AssetEventKind;
  detail: string;
  note: string | null;
  by: string;
  at: Date;
}

export async function getAsset(
  database: Database,
  ctx: TenantContext,
  assetId: string,
): Promise<{ asset: Asset; events: AssetEvent[] } | null> {
  assertAllowed(ctx, "inventory.view");
  if (!UUID.safeParse(assetId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [asset] = await selectAssets(tx).where(
      and(eq(assets.tenantId, ctx.tenant.id), eq(assets.id, assetId)),
    );
    if (!asset) return null;
    const events = await tx
      .select({
        id: assetEvents.id,
        kind: assetEvents.kind,
        detail: assetEvents.detail,
        note: assetEvents.note,
        by: users.name,
        at: assetEvents.at,
      })
      .from(assetEvents)
      .innerJoin(users, eq(users.id, assetEvents.byUserId))
      .where(and(eq(assetEvents.tenantId, ctx.tenant.id), eq(assetEvents.assetId, assetId)))
      .orderBy(desc(assetEvents.at));
    return { asset, events };
  });
}

const custodianFields = {
  custodianMembershipId: z.preprocess(blank, UUID.nullable().optional()),
  custodianName: optionalText(120),
};

const assetSchema = (currency: string) =>
  z.object({
    name: requiredText(1, 120, "Name the asset, e.g. Dell laptop or Classroom projector."),
    category: optionalText(60),
    serialNumber: optionalText(80),
    location: optionalText(120),
    ...custodianFields,
    condition: z.enum(ASSET_CONDITIONS, { message: "Choose its condition." }),
    acquiredOn: z.preprocess(
      blank,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
        .nullable()
        .optional(),
    ),
    cost: optionalMoney(currency),
    supplierId: z.preprocess(blank, UUID.nullable().optional()),
    note: optionalText(300),
  });

async function custodianLabel(
  tx: Transaction,
  ctx: TenantContext,
  membershipId: string | null | undefined,
  name: string | null | undefined,
): Promise<{ membershipId: string | null; name: string | null; label: string }> {
  if (membershipId) {
    const [m] = await tx
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.id, membershipId),
          eq(memberships.status, "active"),
        ),
      );
    if (!m) throw new DomainError("not_found", "Choose a member of staff.", "custodianMembershipId");
    return { membershipId, name: null, label: m.name };
  }
  return { membershipId: null, name: name ?? null, label: name ?? "nobody" };
}

async function assertSupplier(tx: Transaction, ctx: TenantContext, supplierId: string | null | undefined) {
  if (!supplierId) return;
  const [s] = await tx
    .select({ id: inventorySuppliers.id })
    .from(inventorySuppliers)
    .where(and(eq(inventorySuppliers.tenantId, ctx.tenant.id), eq(inventorySuppliers.id, supplierId)));
  if (!s) throw new DomainError("not_found", "Choose a supplier.", "supplierId");
}

const event = (
  tx: Transaction,
  ctx: TenantContext,
  assetId: string,
  kind: AssetEventKind,
  detail: string,
  note?: string | null,
) =>
  tx.insert(assetEvents).values({
    tenantId: ctx.tenant.id,
    assetId,
    kind,
    detail: detail.slice(0, 300),
    note: note ?? null,
    byUserId: ctx.userId,
  });

/** Adds an asset to the register with the next tag (A0001). */
export async function addAsset(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<{ id: string; tag: string }> {
  assertAllowed(ctx, "inventory.manage");
  const data = assetSchema(ctx.tenant.currencyCode).parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const custodian = await custodianLabel(tx, ctx, data.custodianMembershipId, data.custodianName);
    await assertSupplier(tx, ctx, data.supplierId);
    const tag = assetTag(await nextNumber(tx, ctx.tenant.id, "asset_tag"));
    const [row] = await tx
      .insert(assets)
      .values({
        tenantId: ctx.tenant.id,
        tag,
        name: data.name,
        category: data.category ?? null,
        serialNumber: data.serialNumber ?? null,
        location: data.location ?? null,
        custodianMembershipId: custodian.membershipId,
        custodianName: custodian.name,
        condition: data.condition,
        acquiredOn: data.acquiredOn ?? null,
        costMinor: data.cost,
        supplierId: data.supplierId ?? null,
        note: data.note ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: assets.id });
    await event(
      tx,
      ctx,
      row!.id,
      "added",
      [
        data.location && `at ${data.location}`,
        custodian.label !== "nobody" && `with ${custodian.label}`,
        CONDITION_LABELS[data.condition].toLowerCase(),
      ]
        .filter(Boolean)
        .join(", ") || "Added",
    );
    await audit(tx, ctx, "inventory.asset_added", "asset", row!.id, { tag, name: data.name });
    return { id: row!.id, tag };
  });
}

const detailsSchema = (currency: string) =>
  z.object({
    name: requiredText(1, 120, "Name the asset."),
    category: optionalText(60),
    serialNumber: optionalText(80),
    acquiredOn: z.preprocess(
      blank,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
        .nullable()
        .optional(),
    ),
    cost: optionalMoney(currency),
    supplierId: z.preprocess(blank, UUID.nullable().optional()),
    note: optionalText(300),
  });

async function lockActive(tx: Transaction, ctx: TenantContext, assetId: string) {
  if (!UUID.safeParse(assetId).success) throw new DomainError("not_found", "Asset not found.");
  const [row] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.tenantId, ctx.tenant.id), eq(assets.id, assetId)))
    .for("update");
  if (!row) throw new DomainError("not_found", "Asset not found.");
  if (row.status === "disposed") throw new DomainError("disposed", "This asset has been disposed of.");
  return row;
}

/** Corrects an asset's description (name, serial, purchase details); its history of moves stays as it is. */
export async function updateAssetDetails(
  database: Database,
  ctx: TenantContext,
  assetId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  const data = detailsSchema(ctx.tenant.currencyCode).parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await lockActive(tx, ctx, assetId);
    await assertSupplier(tx, ctx, data.supplierId);
    await tx
      .update(assets)
      .set({
        name: data.name,
        category: data.category ?? null,
        serialNumber: data.serialNumber ?? null,
        acquiredOn: data.acquiredOn ?? null,
        costMinor: data.cost,
        supplierId: data.supplierId ?? null,
        note: data.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));
    await audit(tx, ctx, "inventory.asset_changed", "asset", assetId, {
      fields: Object.keys(input).filter((k) => k in data),
    });
  });
}

const changeSchema = z.object({
  location: optionalText(120),
  ...custodianFields,
  condition: z.enum(ASSET_CONDITIONS, { message: "Choose its condition." }),
  note: optionalText(300),
});

/** Moves an asset, hands it to another custodian or records its condition; each change is kept as history. */
export async function changeAsset(
  database: Database,
  ctx: TenantContext,
  assetId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  const data = changeSchema.parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const before = await lockActive(tx, ctx, assetId);
    const custodian = await custodianLabel(tx, ctx, data.custodianMembershipId, data.custodianName);
    const beforeCustodian = await custodianLabel(
      tx,
      ctx,
      before.custodianMembershipId,
      before.custodianName,
    ).catch(() => ({ label: before.custodianName ?? "a former member" }));
    const location = data.location ?? null;
    const changes: { kind: AssetEventKind; detail: string }[] = [];
    if (location !== before.location)
      changes.push({
        kind: "moved",
        detail: `${before.location ?? "No location"} → ${location ?? "No location"}`,
      });
    if (custodian.membershipId !== before.custodianMembershipId || custodian.name !== before.custodianName)
      changes.push({ kind: "custodian", detail: `${beforeCustodian.label} → ${custodian.label}` });
    if (data.condition !== before.condition)
      changes.push({
        kind: "condition",
        detail: `${CONDITION_LABELS[before.condition]} → ${CONDITION_LABELS[data.condition]}`,
      });
    if (!changes.length) throw new DomainError("no_change", "Nothing has changed.");
    await tx
      .update(assets)
      .set({
        location,
        custodianMembershipId: custodian.membershipId,
        custodianName: custodian.name,
        condition: data.condition,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId));
    for (const c of changes) await event(tx, ctx, assetId, c.kind, c.detail, data.note);
    await audit(tx, ctx, "inventory.asset_moved", "asset", assetId, { changes: changes.map((c) => c.kind) });
  });
}

/** Disposes of an asset (sold, scrapped, lost, stolen), once, with a reason; it stays in the register. */
export async function disposeAsset(
  database: Database,
  ctx: TenantContext,
  assetId: string,
  reasonInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  const reason = requiredText(3, 300, "Say why, e.g. sold, beyond repair or stolen.").safeParse(reasonInput);
  if (!reason.success)
    throw new DomainError("reason_required", "Say why, e.g. sold, beyond repair or stolen.", "reason");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await lockActive(tx, ctx, assetId);
    await tx
      .update(assets)
      .set({ status: "disposed", disposedAt: new Date(), disposalReason: reason.data, updatedAt: new Date() })
      .where(eq(assets.id, assetId));
    await event(tx, ctx, assetId, "disposed", reason.data);
    await audit(tx, ctx, "inventory.asset_disposed", "asset", assetId, { reason: reason.data });
  });
}
