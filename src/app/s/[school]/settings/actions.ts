"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { schoolProfileSchema, updateSchoolProfile } from "@/server/tenancy/service";
import { can } from "@/server/authz/permissions";
import { getClientInfo, requireTenant } from "@/web/auth";
import { schoolPath } from "@/lib/routes";

export interface ProfileFormState {
  status: "idle" | "saved" | "error";
  message?: string;
  fieldErrors?: Partial<Record<"name" | "timezone", string>>;
}

export async function saveSchoolProfile(
  slug: string,
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const { ctx } = await requireTenant(slug);
  if (!can(ctx.roles, "school.settings.manage")) {
    return { status: "error", message: "You do not have permission to change these settings." };
  }
  const parsed = schoolProfileSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
  });
  if (!parsed.success) {
    const fieldErrors: ProfileFormState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if ((key === "name" || key === "timezone") && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }
  const { ipAddress } = await getClientInfo();
  await updateSchoolProfile(db(), ctx, parsed.data, { ipAddress });
  revalidatePath(schoolPath(slug), "layout");
  return { status: "saved", message: "School profile saved." };
}
