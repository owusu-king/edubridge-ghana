"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { addPaymentEvidence, removePaymentEvidence } from "@/server/fees/evidence";
import { voidPayment } from "@/server/fees/payments";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function voidPaymentAction(
  slug: string,
  paymentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await voidPayment(db(), ctx, paymentId, { reason: formData.get("reason") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "fees"), "layout");
  return { status: "success", message: "Receipt voided." };
}

export async function addEvidenceAction(
  slug: string,
  paymentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  try {
    await addPaymentEvidence(db(), ctx, paymentId, {
      filename: file instanceof File ? file.name : "",
      bytes: file instanceof File ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0),
    });
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, `fees/receipts/${paymentId}`));
  return { status: "success", message: "Evidence attached." };
}

export async function removeEvidenceAction(
  slug: string,
  paymentId: string,
  fileId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await removePaymentEvidence(db(), ctx, paymentId, fileId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, `fees/receipts/${paymentId}`));
  return { status: "success", message: "Removed." };
}
