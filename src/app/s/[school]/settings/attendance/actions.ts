"use server";

import { revalidatePath } from "next/cache";
import { saveAbsenceAlertSettings } from "@/server/attendance/alerts";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function saveAlertSettingsAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveAbsenceAlertSettings(db(), ctx, {
      enabled: formData.get("enabled") === "on",
      consecutiveDays: formData.get("consecutiveDays"),
      termDays: formData.get("termDays"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "settings/attendance"));
  return { status: "success", message: "Absence SMS settings saved." };
}
