import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { purchaseReference, requestTotal, type PurchaseStatus } from "../../lib/inventory";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  inventorySuppliers,
  purchaseRequestLines,
  purchaseRequests,
  stockItems,
  stockMovements,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import {
  audit,
  blank,
  nextNumber,
  optionalMoney,
  optionalText,
  requiredText,
  scopeOf,
  UUID,
  wholeNumber,
} from "./common";
import { lockItem } from "./stock";

/**
 * Purchase requests (R4-6 INV-02b). Lines never change. The Proprietor approves or declines once, never their own
 * request (database check); the person asking can cancel while it waits; an approved request is received (what
 * arrived, added to stock for lines with a stock item) or cancelled. Statuses only move forward (database).
 * EduBridge does not pay suppliers.
 */

export const MAX_LINES = 10;

export interface PurchaseLine {
  id: string;
  description: string;
  quantity: number;
  unitPriceMinor: number | null;
  stockItemId: string | null;
  stockItem: string | null;
  receivedQuantity: number | null;
}

export interface PurchaseSummary {
  id: string;
  reference: string;
  title: string;
  status: PurchaseStatus;
  supplier: string | null;
  requestedBy: string;
  requestedByUserId: string;
  requestedAt: Date;
  totalMinor: number;
}

export interface PurchaseDetail extends PurchaseSummary {
  reason: string | null;
  supplierId: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  closedBy: string | null;
  closedAt: Date | null;
  closingNote: string | null;
  lines: PurchaseLine[];
}

const requester = alias(users, "requester");
const decider = alias(users, "decider");
const closer = alias(users, "closer");

const totalSql = sql<number>`(select coalesce(sum(l.quantity * coalesce(l.unit_price_minor, 0)), 0)::bigint from purchase_request_lines l where l.request_id = ${purchaseRequests.id})`;

export async function listPurchaseRequests(
  database: Database,
  ctx: TenantContext,
): Promise<PurchaseSummary[]> {
  assertAllowed(ctx, "inventory.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: purchaseRequests.id,
        reference: purchaseRequests.reference,
        title: purchaseRequests.title,
        status: purchaseRequests.status,
        supplier: inventorySuppliers.name,
        requestedBy: requester.name,
        requestedByUserId: purchaseRequests.requestedByUserId,
        requestedAt: purchaseRequests.requestedAt,
        totalMinor: totalSql,
      })
      .from(purchaseRequests)
      .innerJoin(requester, eq(requester.id, purchaseRequests.requestedByUserId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, purchaseRequests.supplierId))
      .where(eq(purchaseRequests.tenantId, ctx.tenant.id))
      .orderBy(sql`${purchaseRequests.status} = 'pending' desc`, desc(purchaseRequests.requestedAt))
      .limit(300);
    return rows.map((r) => ({ ...r, totalMinor: Number(r.totalMinor) }));
  });
}

export async function getPurchaseRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
): Promise<PurchaseDetail | null> {
  assertAllowed(ctx, "inventory.view");
  if (!UUID.safeParse(requestId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({
        r: purchaseRequests,
        supplier: inventorySuppliers.name,
        requestedBy: requester.name,
        decidedBy: decider.name,
        closedBy: closer.name,
      })
      .from(purchaseRequests)
      .innerJoin(requester, eq(requester.id, purchaseRequests.requestedByUserId))
      .leftJoin(decider, eq(decider.id, purchaseRequests.decidedByUserId))
      .leftJoin(closer, eq(closer.id, purchaseRequests.closedByUserId))
      .leftJoin(inventorySuppliers, eq(inventorySuppliers.id, purchaseRequests.supplierId))
      .where(and(eq(purchaseRequests.tenantId, ctx.tenant.id), eq(purchaseRequests.id, requestId)));
    if (!row) return null;
    const lines = await tx
      .select({
        id: purchaseRequestLines.id,
        description: purchaseRequestLines.description,
        quantity: purchaseRequestLines.quantity,
        unitPriceMinor: purchaseRequestLines.unitPriceMinor,
        stockItemId: purchaseRequestLines.stockItemId,
        stockItem: stockItems.name,
        receivedQuantity: purchaseRequestLines.receivedQuantity,
      })
      .from(purchaseRequestLines)
      .leftJoin(stockItems, eq(stockItems.id, purchaseRequestLines.stockItemId))
      .where(
        and(eq(purchaseRequestLines.tenantId, ctx.tenant.id), eq(purchaseRequestLines.requestId, requestId)),
      )
      .orderBy(asc(purchaseRequestLines.position));
    const r = row.r;
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      status: r.status,
      supplier: row.supplier,
      supplierId: r.supplierId,
      requestedBy: row.requestedBy,
      requestedByUserId: r.requestedByUserId,
      requestedAt: r.requestedAt,
      totalMinor: requestTotal(lines),
      reason: r.reason,
      decidedBy: row.decidedBy,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      closedBy: row.closedBy,
      closedAt: r.closedAt,
      closingNote: r.closingNote,
      lines,
    };
  });
}

/** Reads the request's lines from form fields `description_0`, `quantity_0`, `price_0`, `stockItemId_0`, … */
function parseLines(input: Record<string, unknown>, currency: string) {
  const lines: {
    description: string;
    quantity: number;
    unitPriceMinor: number | null;
    stockItemId: string | null;
  }[] = [];
  for (let i = 0; i < MAX_LINES; i++) {
    // A field left out and a field left empty are the same: nothing on this line.
    const description = blank(input[`description_${i}`] ?? null);
    const quantity = blank(input[`quantity_${i}`] ?? null);
    const price = blank(input[`price_${i}`] ?? null);
    if (description === null && quantity === null && price === null) continue;
    const field = (name: string) => `${name}_${i}`;
    const d = requiredText(1, 200, "Say what is needed.").safeParse(description ?? "");
    if (!d.success) throw new DomainError("invalid", "Say what is needed.", field("description"));
    const q = wholeNumber(1, 1_000_000, "Enter how many.").safeParse(quantity);
    if (!q.success) throw new DomainError("invalid", "Enter how many.", field("quantity"));
    const p = optionalMoney(currency).safeParse(price);
    if (!p.success) throw new DomainError("invalid", "Enter a price, e.g. 45.00.", field("price"));
    const s = z.preprocess(blank, UUID.nullable().optional()).safeParse(input[`stockItemId_${i}`] ?? null);
    lines.push({
      description: d.data,
      quantity: q.data,
      unitPriceMinor: p.data,
      stockItemId: s.success ? (s.data ?? null) : null,
    });
  }
  if (!lines.length) throw new DomainError("no_lines", "Add at least one thing to buy.", "description_0");
  return lines;
}

/** Raises a purchase request (PR0001) for the Proprietor to approve. */
export async function createPurchaseRequest(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<{ id: string; reference: string }> {
  assertAllowed(ctx, "purchases.request");
  const head = z
    .object({
      title: requiredText(3, 120, "Say what this is for, e.g. Exam paper for end of term."),
      reason: optionalText(1000),
      supplierId: z.preprocess(blank, UUID.nullable().optional()),
    })
    .parse(input);
  const lines = parseLines(input, ctx.tenant.currencyCode);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (head.supplierId) {
      const [s] = await tx
        .select({ id: inventorySuppliers.id })
        .from(inventorySuppliers)
        .where(
          and(eq(inventorySuppliers.tenantId, ctx.tenant.id), eq(inventorySuppliers.id, head.supplierId)),
        );
      if (!s) throw new DomainError("not_found", "Choose a supplier.", "supplierId");
    }
    for (const line of lines.filter((l) => l.stockItemId)) {
      const [item] = await tx
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.id, line.stockItemId!)));
      if (!item) throw new DomainError("not_found", "Choose a stock item.");
    }
    const reference = purchaseReference(await nextNumber(tx, ctx.tenant.id, "purchase_request"));
    const [row] = await tx
      .insert(purchaseRequests)
      .values({
        tenantId: ctx.tenant.id,
        reference,
        title: head.title,
        reason: head.reason ?? null,
        supplierId: head.supplierId ?? null,
        requestedByUserId: ctx.userId,
      })
      .returning({ id: purchaseRequests.id });
    await tx
      .insert(purchaseRequestLines)
      .values(lines.map((l, position) => ({ tenantId: ctx.tenant.id, requestId: row!.id, position, ...l })));
    await audit(tx, ctx, "purchases.requested", "purchase_request", row!.id, {
      reference,
      totalMinor: requestTotal(lines),
      currency: ctx.tenant.currencyCode,
    });
    return { id: row!.id, reference };
  });
}

async function lockRequest(tx: Transaction, ctx: TenantContext, requestId: string) {
  if (!UUID.safeParse(requestId).success) throw new DomainError("not_found", "Request not found.");
  const [row] = await tx
    .select()
    .from(purchaseRequests)
    .where(and(eq(purchaseRequests.tenantId, ctx.tenant.id), eq(purchaseRequests.id, requestId)))
    .for("update");
  if (!row) throw new DomainError("not_found", "Request not found.");
  return row;
}

/** The Proprietor approves or declines (with a note) a waiting request, once, and never their own. */
export async function decidePurchaseRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  input: { approve: boolean; note?: unknown },
): Promise<void> {
  assertAllowed(ctx, "purchases.approve");
  const note = optionalText(500).parse(input.note ?? null) ?? null;
  if (!input.approve && (!note || note.length < 3))
    throw new DomainError("note_required", "Say why it is declined.", "note");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const row = await lockRequest(tx, ctx, requestId);
    if (row.status !== "pending")
      throw new DomainError("decided", "This request has already been dealt with.");
    if (row.requestedByUserId === ctx.userId)
      throw new DomainError("own_request", "Someone else must decide on your own request.");
    await tx
      .update(purchaseRequests)
      .set({
        status: input.approve ? "approved" : "declined",
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
        decisionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(purchaseRequests.id, requestId));
    await audit(
      tx,
      ctx,
      input.approve ? "purchases.approved" : "purchases.declined",
      "purchase_request",
      requestId,
      {
        reference: row.reference,
      },
    );
  });
}

/** Cancels a request: the person asking while it waits; those who manage inventory while waiting or approved. */
export async function cancelPurchaseRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  noteInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "purchases.request");
  const note = optionalText(500).parse(noteInput ?? null) ?? null;
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const row = await lockRequest(tx, ctx, requestId);
    const mine = row.requestedByUserId === ctx.userId;
    const office = allowed(ctx, "inventory.manage") || allowed(ctx, "purchases.approve");
    const canCancel = (row.status === "pending" && (mine || office)) || (row.status === "approved" && office);
    if (!canCancel)
      throw new DomainError(
        "cannot_cancel",
        row.status === "pending" || row.status === "approved"
          ? "Only the person who asked, or the office, can cancel this."
          : "This request is already closed.",
      );
    await tx
      .update(purchaseRequests)
      .set({
        status: "cancelled",
        closedByUserId: ctx.userId,
        closedAt: new Date(),
        closingNote: note,
        updatedAt: new Date(),
      })
      .where(eq(purchaseRequests.id, requestId));
    await audit(tx, ctx, "purchases.cancelled", "purchase_request", requestId, { reference: row.reference });
  });
}

/**
 * Records what arrived for an approved request (field `received_<lineId>`, a whole number per line), once. Lines
 * with a stock item add that many to stock, with the line's price as the unit cost and the request's supplier.
 */
export async function receivePurchaseRequest(
  database: Database,
  ctx: TenantContext,
  requestId: string,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  const note = optionalText(500).parse(input.note ?? null) ?? null;
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const row = await lockRequest(tx, ctx, requestId);
    if (row.status !== "approved")
      throw new DomainError("not_approved", "Only an approved request can be received.");
    const lines = await tx
      .select()
      .from(purchaseRequestLines)
      .where(
        and(eq(purchaseRequestLines.tenantId, ctx.tenant.id), eq(purchaseRequestLines.requestId, requestId)),
      )
      .orderBy(asc(purchaseRequestLines.position));
    const received: { id: string; quantity: number }[] = [];
    for (const line of lines) {
      const parsed = wholeNumber(0, 1_000_000, "Enter how many arrived.").safeParse(
        input[`received_${line.id}`],
      );
      if (!parsed.success)
        throw new DomainError("invalid", "Enter how many arrived (0 if none).", `received_${line.id}`);
      received.push({ id: line.id, quantity: parsed.data });
    }
    for (const line of lines) {
      const quantity = received.find((r) => r.id === line.id)!.quantity;
      await tx
        .update(purchaseRequestLines)
        .set({ receivedQuantity: quantity })
        .where(eq(purchaseRequestLines.id, line.id));
      if (line.stockItemId && quantity > 0) {
        const item = await lockItem(tx, ctx.tenant.id, line.stockItemId);
        if (!item) continue;
        await tx.insert(stockMovements).values({
          tenantId: ctx.tenant.id,
          itemId: line.stockItemId,
          kind: "received",
          quantity,
          unitCostMinor: line.unitPriceMinor,
          supplierId: row.supplierId,
          purchaseRequestId: row.id,
          recordedByUserId: ctx.userId,
        });
      }
    }
    await tx
      .update(purchaseRequests)
      .set({
        status: "received",
        closedByUserId: ctx.userId,
        closedAt: new Date(),
        closingNote: note,
        updatedAt: new Date(),
      })
      .where(eq(purchaseRequests.id, requestId));
    await audit(tx, ctx, "purchases.received", "purchase_request", requestId, {
      reference: row.reference,
      lines: received.length,
    });
  });
}
