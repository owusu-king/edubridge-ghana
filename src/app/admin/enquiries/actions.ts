"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { markEnquiryHandled } from "@/server/enquiries/service";
import { requirePlatformAdmin } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Platform staff: marking a landing-page enquiry as handled (2026-11-19). */
export async function markHandledAction(id: string, _prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await markEnquiryHandled(db(), user.id, id);
    revalidatePath("/admin/enquiries");
    return { status: "success", message: "Marked as handled." };
  } catch (error) {
    return toFormError(error);
  }
}
