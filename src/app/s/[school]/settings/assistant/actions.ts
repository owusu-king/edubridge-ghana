"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { saveAssistantPreferences } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function saveAssistantPreferencesAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveAssistantPreferences(db(), ctx, {
      assistantEnabled: formData.get("assistantEnabled") === "on",
      assistantShareNames: formData.get("assistantShareNames") === "on",
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message: "Saved." };
}
