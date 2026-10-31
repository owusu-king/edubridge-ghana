"use server";

import { redirect } from "next/navigation";
import { resetPassword } from "@/server/auth/password-reset";
import { db } from "@/server/db/client";
import { clearSessionCookie } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function resetPasswordAction(
  token: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await resetPassword(db(), token, { password: formData.get("password") });
  } catch (error) {
    return toFormError(error);
  }
  await clearSessionCookie();
  redirect("/login?reset=1");
}
