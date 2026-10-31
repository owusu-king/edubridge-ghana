"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { signIn, signInSchema } from "@/server/auth/sign-in";
import { db } from "@/server/db/client";
import { safeRedirectPath } from "@/lib/format";
import { getClientInfo, setSessionCookie } from "@/web/auth";

export interface SignInFormState {
  error?: string;
  email?: string;
}

export async function signInAction(_prev: SignInFormState, formData: FormData): Promise<SignInFormState> {
  const email = String(formData.get("email") ?? "");
  const parsed = signInSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check your details.", email };

  const result = await signIn(db(), parsed.data, await getClientInfo());
  if (!result.ok) {
    return {
      email,
      error:
        result.reason === "throttled"
          ? "Too many unsuccessful attempts. Wait 15 minutes, then try again."
          : "The email or password is incorrect.",
    };
  }
  await setSessionCookie(result.token);
  redirect(safeRedirectPath(formData.get("next"), "/") as Route);
}
