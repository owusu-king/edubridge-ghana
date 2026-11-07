"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { endSupportAccess, grantSupportAccess } from "@/server/support/access";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function grantSupportAccessAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await grantSupportAccess(db(), ctx, { hours: formData.get("hours"), note: formData.get("note") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message: "Support access allowed." };
}

export async function endSupportAccessAction(slug: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await endSupportAccess(db(), ctx);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug), "layout");
  return {
    status: "success",
    message: "Support access ended. EduBridge support can no longer open the school.",
  };
}
