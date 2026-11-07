"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { saveOverviewPreferences, saveSchoolContacts } from "@/server/tenancy/preferences";
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

export async function saveOverviewPreferencesAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveOverviewPreferences(db(), ctx, {
      collectionRateBasis: formData.get("collectionRateBasis"),
      attendanceConcernPercent: formData.get("attendanceConcernPercent"),
      attendanceConcernMinDays: formData.get("attendanceConcernMinDays"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message: "Overview settings saved." };
}

export async function saveSchoolContactsAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveSchoolContacts(db(), ctx, {
      contactPhone: formData.get("contactPhone"),
      contactWhatsapp: formData.get("contactWhatsapp"),
      contactEmail: formData.get("contactEmail"),
      officeHours: formData.get("officeHours"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "settings"));
  return { status: "success", message: "Contact details saved. Families see them in the parent view." };
}
