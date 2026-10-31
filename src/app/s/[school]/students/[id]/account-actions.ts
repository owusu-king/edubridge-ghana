"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { reverseEntry } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function reverseEntryAction(
  slug: string,
  studentId: string,
  entryId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await reverseEntry(db(), ctx, entryId, { reason: formData.get("reason") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  return { status: "success", message: "Entry reversed." };
}

/** Records a payment and opens its receipt. */
export async function recordPaymentAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let paymentId: string;
  try {
    ({ paymentId } = await recordPayment(db(), ctx, {
      studentId,
      amount: formData.get("amount") ?? "",
      method: formData.get("method"),
      reference: formData.get("reference") ?? undefined,
      payerName: formData.get("payerName") ?? undefined,
      paidOn: formData.get("paidOn"),
      idempotencyKey: formData.get("idempotencyKey"),
    }));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  redirect(schoolPath(slug, `fees/receipts/${paymentId}`));
}
