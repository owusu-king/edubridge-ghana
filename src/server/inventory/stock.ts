import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isLow, MOVEMENT_KINDS, signedQuantity, type MovementKind } from "../../lib/inventory";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { inventorySuppliers, stockItems, stockMovements, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import {
  audit,
  nameTaken,
  optionalMoney,
  optionalText,
  optionalWholeNumber,
  requiredText,
  scopeOf,
  UUID,
  wholeNumber,
} from "./common";

/**
 * Stock (R4-6 INV-01a, INV-01b). Stock changes only by movements, which are never changed or deleted (database);
 * what is on hand is their sum. An issue locks the item first, so two people issuing at once cannot take stock
 * below zero.
 */

export interface StockItem {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  reorderLevel: number | null;
  status: "active" | "archived";
  onHand: number;
  low: boolean;
}

/**
 * What is on hand. The outer column is written out in full: in a query on one table Drizzle leaves it unqualified,
 * where it would bind to the movement's own id.
 */
const onHandSql = sql<number>`(select coalesce(sum(m.quantity), 0)::int from stock_movements m where m.item_id = stock_items.id)`;

async function readItems(tx: Queryable, tenantId: string, itemId?: string): Promise<StockItem[]> {
  const rows = await tx
    .select({
      id: stockItems.id,
      name: stockItems.name,
      category: stockItems.category,
      unit: stockItems.unit,
      reorderLevel: stockItems.reorderLevel,
      status: stockItems.status,
      onHand: onHandSql,
    })
    .from(stockItems)
    .where(and(eq(stockItems.tenantId, tenantId), itemId ? eq(stockItems.id, itemId) : undefined))
    .orderBy(asc(stockItems.status), asc(stockItems.category), asc(stockItems.name));
  return rows.map((r) => ({ ...r, low: r.status === "active" && isLow(r) }));
}

export async function listStockItems(database: Database, ctx: TenantContext): Promise<StockItem[]> {
  assertAllowed(ctx, "inventory.view");
  return withTenant(database, scopeOf(ctx), (tx) => readItems(tx, ctx.tenant.id));
}

/** Active stock items, for the stock item on a purchase request line. */
export async function listStockChoices(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "purchases.request");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: stockItems.id, name: stockItems.name, unit: stockItems.unit })
      .from(stockItems)
      .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.status, "active")))
      .orderBy(asc(stockItems.name)),
  );
}

const itemSchema = z.object({
  name: requiredText(1, 80, "Name the item."),
  category: optionalText(60),
  unit: requiredText(1, 30, "Say what one of it is, e.g. ream, box or bag."),
  reorderLevel: optionalWholeNumber(0, 1_000_000),
});

/** Adds a stock item, or changes one when `itemId` is given (never its movements). */
export async function saveStockItem(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  itemId?: string,
): Promise<string> {
  assertAllowed(ctx, "inventory.manage");
  const data = itemSchema.parse(input);
  const values = {
    name: data.name,
    category: data.category ?? null,
    unit: data.unit,
    reorderLevel: data.reorderLevel,
  };
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (itemId) {
      if (!UUID.safeParse(itemId).success) throw new DomainError("not_found", "Item not found.");
      const [row] = await tx
        .update(stockItems)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.id, itemId)))
        .returning({ id: stockItems.id });
      if (!row) throw new DomainError("not_found", "Item not found.");
      await audit(tx, ctx, "inventory.item_changed", "stock_item", row.id, values);
      return row.id;
    }
    const [row] = await tx
      .insert(stockItems)
      .values({ tenantId: ctx.tenant.id, ...values })
      .returning({ id: stockItems.id });
    await audit(tx, ctx, "inventory.item_added", "stock_item", row!.id, values);
    return row!.id;
  }).catch(nameTaken("an item"));
}

export async function setStockItemArchived(
  database: Database,
  ctx: TenantContext,
  itemId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  if (!UUID.safeParse(itemId).success) throw new DomainError("not_found", "Item not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(stockItems)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.id, itemId)))
      .returning({ id: stockItems.id });
    if (!row) throw new DomainError("not_found", "Item not found.");
    await audit(
      tx,
      ctx,
      archived ? "inventory.item_archived" : "inventory.item_restored",
      "stock_item",
      row.id,
    );
  });
}

export interface Movement {
  id: string;
  kind: MovementKind;
  quantity: number;
  unitCostMinor: number | null;
  supplier: string | null;
  issuedTo: string | null;
  reason: string | null;
  purchaseRequestId: string | null;
  recordedBy: string;
  recordedAt: Date;
}

export async function getStockItem(
  database: Database,
  ctx: TenantContext,
  itemId: string,
): Promise<{ item: StockItem; movements: Movement[] } | null> {
  assertAllowed(ctx, "inventory.view");
  if (!UUID.safeParse(itemId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [item] = await readItems(tx, ctx.tenant.id, itemId);
    if (!item) return null;
    const movements = await tx
      .select({
        id: stockMovements.id,
        kind: stockMovements.kind,
        quantity: stockMovements.quantity,
        unitCostMinor: stockMovements.unitCostMinor,
        supplier: inventorySuppliers.name,
        issuedTo: stockMovements.issuedTo,
        reason: stockMovements.reason,
        purchaseRequestId: stockMovements.purchaseRequestId,
        recordedBy: users.name,
        recordedAt: stockMovements.recordedAt,
      })
      .from(stockMovements)
      .innerJoin(users, eq(users.id, stockMovements.recordedByUserId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, stockMovements.supplierId))
      .where(and(eq(stockMovements.tenantId, ctx.tenant.id), eq(stockMovements.itemId, itemId)))
      .orderBy(desc(stockMovements.recordedAt))
      .limit(200);
    return { item, movements };
  });
}

/** Locks an item and returns what is on hand (for issues and receipts in the same transaction). */
export async function lockItem(tx: Transaction, tenantId: string, itemId: string) {
  const [item] = await tx
    .select({ id: stockItems.id, name: stockItems.name, unit: stockItems.unit, status: stockItems.status })
    .from(stockItems)
    .where(and(eq(stockItems.tenantId, tenantId), eq(stockItems.id, itemId)))
    .for("update");
  if (!item) return null;
  const [sum] = await tx
    .select({ n: sql<number>`coalesce(sum(${stockMovements.quantity}), 0)::int` })
    .from(stockMovements)
    .where(eq(stockMovements.itemId, itemId));
  return { ...item, onHand: sum!.n };
}

/**
 * Records stock received, issued, or a count correction (INV-01a). For a count the quantity is what is really on
 * the shelf, and the movement is the difference.
 */
export async function recordMovement(
  database: Database,
  ctx: TenantContext,
  itemId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  const kind = z.enum(MOVEMENT_KINDS).safeParse(input.kind);
  if (!kind.success) throw new DomainError("invalid", "Choose received, issued or counted.", "kind");
  const data = z
    .object({
      quantity:
        kind.data === "counted"
          ? wholeNumber(0, 1_000_000, "Enter how many are on the shelf.")
          : wholeNumber(1, 1_000_000, "Enter how many."),
      unitCost: optionalMoney(ctx.tenant.currencyCode),
      supplierId: z.preprocess((v) => (v === "" ? null : v), UUID.nullable().optional()),
      issuedTo:
        kind.data === "issued"
          ? requiredText(2, 120, "Say who or where it went, e.g. Basic 4A or the kitchen.")
          : optionalText(120),
      reason:
        kind.data === "counted" ? requiredText(3, 300, "Say why the count differs.") : optionalText(300),
    })
    .parse(input);
  if (!UUID.safeParse(itemId).success) throw new DomainError("not_found", "Item not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const item = await lockItem(tx, ctx.tenant.id, itemId);
    if (!item) throw new DomainError("not_found", "Item not found.");
    if (item.status !== "active")
      throw new DomainError("archived", "This item is archived. Restore it first.");
    let quantity = signedQuantity(kind.data, data.quantity);
    if (kind.data === "counted") {
      quantity = data.quantity - item.onHand;
      if (quantity === 0)
        throw new DomainError("no_change", `The count matches: ${item.onHand} on hand.`, "quantity");
    }
    if (kind.data === "issued" && item.onHand + quantity < 0)
      throw new DomainError(
        "not_enough",
        `Only ${item.onHand} ${item.unit} on hand. Receive more or correct the count first.`,
        "quantity",
      );
    if (data.supplierId) {
      const [supplier] = await tx
        .select({ id: inventorySuppliers.id })
        .from(inventorySuppliers)
        .where(
          and(eq(inventorySuppliers.tenantId, ctx.tenant.id), eq(inventorySuppliers.id, data.supplierId)),
        );
      if (!supplier) throw new DomainError("not_found", "Choose a supplier.", "supplierId");
    }
    await tx.insert(stockMovements).values({
      tenantId: ctx.tenant.id,
      itemId,
      kind: kind.data,
      quantity,
      unitCostMinor: kind.data === "received" ? data.unitCost : null,
      supplierId: kind.data === "received" ? (data.supplierId ?? null) : null,
      issuedTo: kind.data === "issued" ? data.issuedTo! : null,
      reason: data.reason ?? null,
      recordedByUserId: ctx.userId,
    });
    await audit(tx, ctx, `inventory.stock_${kind.data}`, "stock_item", itemId, {
      item: item.name,
      quantity,
      onHand: item.onHand + quantity,
    });
  });
}
