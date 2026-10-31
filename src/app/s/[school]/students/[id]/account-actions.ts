"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { reverseEntry } from "@/server/fees/ledger";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function reverseEntryAction(
  slug: string,
  studentId: string,
  entryId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await reverseEntry(db(), ctx, entryId, { reason: formData.get("reason") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  return { status: "success", message: "Entry reversed." };
}
