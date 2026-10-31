"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { signIn, signInSchema } from "@/server/auth/sign-in";
import { db } from "@/server/db/client";
import { safeRedirectPath } from "@/lib/format";
import { cookies } from "next/headers";
import { CHALLENGE_LIFETIME_MS } from "@/server/auth/mfa";
import { getClientInfo, setSessionCookie } from "@/web/auth";
import { MFA_COOKIE, mfaCookieOptions } from "@/web/session-cookie";

export interface SignInFormState {
  error?: string;
  email?: string;
}

export async function signInAction(_prev: SignInFormState, formData: FormData): Promise<SignInFormState> {
  const email = String(formData.get("identifier") ?? "");
  const parsed = signInSchema.safeParse({ identifier: email, password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check your details.", email };

  // signIn validates its own (raw) input; parsing above only produces the field error message.
  const result = await signIn(
    db(),
    { identifier: email, password: formData.get("password") as string },
    await getClientInfo(),
  );
  if (!result.ok) {
    return {
      email,
      error:
        result.reason === "throttled"
          ? "Too many unsuccessful attempts. Wait 15 minutes, then try again."
          : "The sign-in details are incorrect.",
    };
  }
  const next = safeRedirectPath(formData.get("next"), "/");
  if (result.ok === "mfa") {
    (await cookies()).set(MFA_COOKIE, result.challengeToken, mfaCookieOptions(CHALLENGE_LIFETIME_MS));
    redirect(`/login/verify${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}` as Route);
  }
  await setSessionCookie(result.token);
  redirect(next as Route);
}
