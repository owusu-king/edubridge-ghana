"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { answerParentConsent } from "@/server/events/consent";
import { requireParent } from "@/web/parent-auth";
import { toFormError, type FormState } from "@/web/forms";

/** A guardian answers a consent form for one child (CNS-01), signed in with their verified number. */
export async function answerFormAction(
  slug: string,
  formId: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { phone } = await requireParent();
  const answer = formData.get("answer");
  try {
    await answerParentConsent(db(), phone, { slug, formId, studentId, answer, note: formData.get("note") });
    revalidatePath("/p", "layout");
    return { status: "success", message: answer === "yes" ? "You answered yes." : "You answered no." };
  } catch (error) {
    return toFormError(error, formData);
  }
}
