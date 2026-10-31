"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { updateSchoolProfile } from "@/server/tenancy/service";
import { getClientInfo, requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { schoolPath } from "@/lib/routes";

export async function saveSchoolProfile(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { ipAddress } = await getClientInfo();
    await updateSchoolProfile(
      db(),
      ctx,
      { name: formData.get("name"), timezone: formData.get("timezone") },
      { ipAddress },
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message: "School profile saved." };
}
