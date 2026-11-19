"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { cancelLeave, decideLeave, requestLeave } from "@/server/staff/leave";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Leave (HR-03): asking for one's own, and deciding others'. */

export async function requestLeaveAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { days } = await requestLeave(db(), ctx, {
      leaveTypeId: formData.get("leaveTypeId"),
      startsOn: formData.get("startsOn"),
      endsOn: formData.get("endsOn"),
      reason: formData.get("reason"),
    });
    revalidatePath(schoolPath(slug, "leave"));
    return { status: "success", message: `Asked for ${days} working ${days === 1 ? "day" : "days"}.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function decideLeaveAction(
  slug: string,
  requestId: string,
  approve: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await decideLeave(db(), ctx, requestId, {
      approve,
      note: formData.get("note"),
      confirmOverBalance: formData.get("confirmOverBalance") === "on",
    });
    revalidatePath(schoolPath(slug, "leave"));
    return { status: "success", message: approve ? "Approved." : "Declined." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function cancelLeaveAction(
  slug: string,
  requestId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelLeave(db(), ctx, requestId);
    revalidatePath(schoolPath(slug, "leave"));
    revalidatePath(schoolPath(slug, "staff"), "layout");
    return { status: "success", message: "Cancelled." };
  } catch (error) {
    return toFormError(error);
  }
}
