"use server";

import { requestPasswordReset } from "@/server/auth/password-reset";
import { db } from "@/server/db/client";
import { getClientInfo } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";

export async function requestResetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    await requestPasswordReset(db(), { identifier: formData.get("identifier") }, await getClientInfo());
  } catch (error) {
    return toFormError(error, formData);
  }
  dispatchAfterResponse();
  // Same answer whether or not the account exists.
  return { status: "success" };
}
