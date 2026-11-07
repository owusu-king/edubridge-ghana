"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { answerConsent, startTransferAsGuardian } from "@/server/passport/transfers";
import { requireParent } from "@/web/parent-auth";
import { toFormError, type FormState } from "@/web/forms";

/** The family's answer to a school asking for their child's records (Transfer Passport). */
export async function answerConsentAction(
  slug: string,
  transferId: string,
  allow: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    await answerConsent(db(), phone, { slug, transferId, allow });
    revalidatePath("/p");
    return {
      status: "success",
      message: allow
        ? "Thank you. The school your child is leaving will now decide."
        : "You refused. The records will not be sent.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

/** The family moves a child to another school; starting it is their consent. */
export async function startTransferAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    await startTransferAsGuardian(db(), phone, { slug, studentId, toSchoolId: formData.get("toSchoolId") });
    revalidatePath(`/p/${slug}/${studentId}`);
    return {
      status: "success",
      message:
        "Request sent. Your child's school will approve it, then the new school will enrol your child.",
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}
