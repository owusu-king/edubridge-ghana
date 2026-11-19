"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { addAsset, changeAsset, disposeAsset, updateAssetDetails } from "@/server/inventory/assets";
import { reportMaintenance, updateMaintenance } from "@/server/inventory/maintenance";
import {
  cancelPurchaseRequest,
  createPurchaseRequest,
  decidePurchaseRequest,
  receivePurchaseRequest,
} from "@/server/inventory/purchases";
import { recordMovement, saveStockItem, setStockItemArchived } from "@/server/inventory/stock";
import { saveSupplier, setSupplierArchived } from "@/server/inventory/suppliers";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Inventory, assets and procurement (R4-6). */

type Ctx = Awaited<ReturnType<typeof requireTenant>>["ctx"];
const fields = (formData: FormData) => Object.fromEntries(formData) as Record<string, unknown>;

async function run(
  slug: string,
  formData: FormData | null,
  work: (ctx: Ctx) => Promise<unknown>,
  message: string,
  ...segments: string[]
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await work(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "inventory"));
  for (const s of segments) revalidatePath(schoolPath(slug, `inventory/${s}`));
  return { status: "success", message };
}

export async function saveStockItemAction(
  slug: string,
  itemId: string | null,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => saveStockItem(db(), ctx, fields(formData), itemId ?? undefined),
    "Saved.",
    ...(itemId ? [`stock/${itemId}`] : []),
  );
}

export async function setStockItemArchivedAction(
  slug: string,
  itemId: string,
  archived: boolean,
  _p: FormState,
) {
  return run(
    slug,
    null,
    (ctx) => setStockItemArchived(db(), ctx, itemId, archived),
    "Saved.",
    `stock/${itemId}`,
  );
}

export async function recordMovementAction(slug: string, itemId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => recordMovement(db(), ctx, itemId, fields(formData)),
    "Recorded.",
    `stock/${itemId}`,
  );
}

export async function saveSupplierAction(
  slug: string,
  supplierId: string | null,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => saveSupplier(db(), ctx, fields(formData), supplierId ?? undefined),
    "Saved.",
    "suppliers",
  );
}

export async function setSupplierArchivedAction(
  slug: string,
  supplierId: string,
  archived: boolean,
  _p: FormState,
) {
  return run(
    slug,
    null,
    (ctx) => setSupplierArchived(db(), ctx, supplierId, archived),
    "Saved.",
    "suppliers",
  );
}

export async function addAssetAction(slug: string, _p: FormState, formData: FormData) {
  return run(slug, formData, (ctx) => addAsset(db(), ctx, fields(formData)), "Added.", "assets");
}

export async function updateAssetAction(slug: string, assetId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => updateAssetDetails(db(), ctx, assetId, fields(formData)),
    "Saved.",
    "assets",
    `assets/${assetId}`,
  );
}

export async function changeAssetAction(slug: string, assetId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => changeAsset(db(), ctx, assetId, fields(formData)),
    "Saved.",
    "assets",
    `assets/${assetId}`,
  );
}

export async function disposeAssetAction(slug: string, assetId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => disposeAsset(db(), ctx, assetId, formData.get("reason")),
    "Disposed of.",
    "assets",
    `assets/${assetId}`,
  );
}

export async function createPurchaseAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => createPurchaseRequest(db(), ctx, fields(formData)),
    "Sent for approval.",
    "purchases",
  );
}

export async function decidePurchaseAction(
  slug: string,
  requestId: string,
  approve: boolean,
  _p: FormState,
  formData?: FormData,
) {
  return run(
    slug,
    formData ?? null,
    (ctx) => decidePurchaseRequest(db(), ctx, requestId, { approve, note: formData?.get("note") }),
    approve ? "Approved." : "Declined.",
    "purchases",
    `purchases/${requestId}`,
  );
}

export async function cancelPurchaseAction(
  slug: string,
  requestId: string,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => cancelPurchaseRequest(db(), ctx, requestId, formData.get("note")),
    "Cancelled.",
    "purchases",
    `purchases/${requestId}`,
  );
}

export async function receivePurchaseAction(
  slug: string,
  requestId: string,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => receivePurchaseRequest(db(), ctx, requestId, fields(formData)),
    "Received.",
    "purchases",
    `purchases/${requestId}`,
  );
}

export async function reportMaintenanceAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => reportMaintenance(db(), ctx, fields(formData)),
    "Reported.",
    "maintenance",
  );
}

export async function updateMaintenanceAction(
  slug: string,
  requestId: string,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => updateMaintenance(db(), ctx, requestId, fields(formData)),
    "Saved.",
    "maintenance",
    `maintenance/${requestId}`,
  );
}
