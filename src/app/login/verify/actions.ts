"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyChallenge } from "@/server/auth/mfa";
import { db } from "@/server/db/client";
import { safeRedirectPath } from "@/lib/format";
import { getClientInfo, setSessionCookie } from "@/web/auth";
import { MFA_COOKIE } from "@/web/session-cookie";

export interface VerifyState {
  error?: string;
  expired?: boolean;
}

export async function verifyAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const jar = await cookies();
  const token = jar.get(MFA_COOKIE)?.value ?? "";
  const code = String(formData.get("code") ?? "").slice(0, 32);
  const result = await verifyChallenge(db(), token, code, await getClientInfo());
  if (!result.ok) {
    if (result.reason === "expired") {
      jar.delete({ name: MFA_COOKIE, path: "/login" });
      return { expired: true, error: "This sign-in has expired or had too many attempts. Sign in again." };
    }
    return { error: "That code is not valid. Try the current code from your app, or a recovery code." };
  }
  jar.delete({ name: MFA_COOKIE, path: "/login" });
  await setSessionCookie(result.session.token);
  redirect(safeRedirectPath(formData.get("next"), "/") as Route);
}
