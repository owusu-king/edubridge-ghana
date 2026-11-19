import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { inventorySuppliers } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { audit, blank, nameTaken, optionalPhone, optionalText, requiredText, scopeOf, UUID } from "./common";

/** Suppliers (R4-6 INV-02a). Archived, never deleted. */

export interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  status: "active" | "archived";
}

export async function listSuppliers(database: Database, ctx: TenantContext): Promise<Supplier[]> {
  assertAllowed(ctx, "inventory.view");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: inventorySuppliers.id,
        name: inventorySuppliers.name,
        contactName: inventorySuppliers.contactName,
        phone: inventorySuppliers.phone,
        email: inventorySuppliers.email,
        note: inventorySuppliers.note,
        status: inventorySuppliers.status,
      })
      .from(inventorySuppliers)
      .where(eq(inventorySuppliers.tenantId, ctx.tenant.id))
      .orderBy(asc(inventorySuppliers.status), asc(inventorySuppliers.name)),
  );
}

const supplierSchema = (country: string) =>
  z.object({
    name: requiredText(1, 120, "Name the supplier."),
    contactName: optionalText(120),
    phone: optionalPhone(country),
    email: z.preprocess(
      blank,
      z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).nullable().optional(),
    ),
    note: optionalText(300),
  });

export async function saveSupplier(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  supplierId?: string,
): Promise<string> {
  assertAllowed(ctx, "inventory.manage");
  const data = supplierSchema(ctx.tenant.countryCode).parse(input);
  const values = {
    name: data.name,
    contactName: data.contactName ?? null,
    phone: data.phone || null,
    email: data.email ?? null,
    note: data.note ?? null,
  };
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (supplierId) {
      if (!UUID.safeParse(supplierId).success) throw new DomainError("not_found", "Supplier not found.");
      const [row] = await tx
        .update(inventorySuppliers)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(inventorySuppliers.tenantId, ctx.tenant.id), eq(inventorySuppliers.id, supplierId)))
        .returning({ id: inventorySuppliers.id });
      if (!row) throw new DomainError("not_found", "Supplier not found.");
      // The name only: contact details stay out of the audit log.
      await audit(tx, ctx, "inventory.supplier_changed", "supplier", row.id, { name: data.name });
      return row.id;
    }
    const [row] = await tx
      .insert(inventorySuppliers)
      .values({ tenantId: ctx.tenant.id, ...values })
      .returning({ id: inventorySuppliers.id });
    await audit(tx, ctx, "inventory.supplier_added", "supplier", row!.id, { name: data.name });
    return row!.id;
  }).catch(nameTaken("a supplier"));
}

export async function setSupplierArchived(
  database: Database,
  ctx: TenantContext,
  supplierId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "inventory.manage");
  if (!UUID.safeParse(supplierId).success) throw new DomainError("not_found", "Supplier not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(inventorySuppliers)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(inventorySuppliers.tenantId, ctx.tenant.id), eq(inventorySuppliers.id, supplierId)))
      .returning({ id: inventorySuppliers.id });
    if (!row) throw new DomainError("not_found", "Supplier not found.");
    await audit(
      tx,
      ctx,
      archived ? "inventory.supplier_archived" : "inventory.supplier_restored",
      "supplier",
      row.id,
    );
  });
}
