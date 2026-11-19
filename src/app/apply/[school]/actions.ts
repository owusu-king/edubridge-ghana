"use server";

import { confirmOnlineApplication, startOnlineApplication } from "@/server/admissions/online";
import { db } from "@/server/db/client";
import { dispatchAfterResponse } from "@/web/notify";
import { getClientInfo } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export type ApplyState = FormState<{ verificationId?: string; reference?: string }>;

/** Step 1: the form is checked and a code is texted to the parent's phone. */
export async function startApplicationAction(
  slug: string,
  _prev: ApplyState,
  formData: FormData,
): Promise<ApplyState> {
  try {
    const { verificationId } = await startOnlineApplication(
      db(),
      slug,
      Object.fromEntries(formData.entries()),
      await getClientInfo(),
    );
    dispatchAfterResponse();
    return { status: "success", data: { verificationId } };
  } catch (error) {
    return toFormError(error, formData);
  }
}

/** Step 2: the code from the SMS turns the form into an application. */
export async function confirmApplicationAction(
  slug: string,
  _prev: ApplyState,
  formData: FormData,
): Promise<ApplyState> {
  const verificationId = String(formData.get("verificationId") ?? "");
  try {
    const { reference } = await confirmOnlineApplication(db(), slug, {
      verificationId,
      code: String(formData.get("code") ?? ""),
    });
    return { status: "success", data: { verificationId, reference } };
  } catch (error) {
    return toFormError(error, formData);
  }
}
