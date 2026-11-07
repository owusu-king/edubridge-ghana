"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { saveMessageSettings } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function saveMessageSettingsAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveMessageSettings(db(), ctx, {
      paymentReceiptSms: formData.get("paymentReceiptSms") === "on",
      autoRemindersEnabled: formData.get("autoRemindersEnabled") === "on",
      autoReminderIntervalDays: formData.get("autoReminderIntervalDays"),
      autoReminderMin: String(formData.get("autoReminderMin") ?? ""),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "settings/messages"));
  return { status: "success", message: "Message settings saved." };
}
