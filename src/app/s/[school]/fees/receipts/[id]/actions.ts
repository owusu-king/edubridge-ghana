"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
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
