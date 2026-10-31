"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { updateMfaPolicy } from "@/server/tenancy/service";
import { schoolPath } from "@/lib/routes";
import { getClientInfo, requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function saveMfaPolicyAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { ipAddress } = await getClientInfo();
    await updateMfaPolicy(db(), ctx, { roles: formData.getAll("roles").map(String) }, { ipAddress });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message: "Security policy saved." };
}
