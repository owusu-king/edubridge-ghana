"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { CODE_LIFETIME_MS, requestParentCode, verifyParentCode } from "@/server/parents/sign-in";
import { getClientInfo } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";
import { parentNext, setParentSessionCookie } from "@/web/parent-auth";
import { PARENT_CODE_COOKIE, parentCodeCookieOptions } from "@/web/session-cookie";

export async function requestCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let requestId: string;
  try {
    ({ requestId } = await requestParentCode(db(), formData.get("phone"), await getClientInfo()));
  } catch (error) {
    return toFormError(error, formData);
  }
  dispatchAfterResponse();
  (await cookies()).set(PARENT_CODE_COOKIE, requestId, parentCodeCookieOptions(CODE_LIFETIME_MS));
  const next = parentNext(formData.get("next"));
  redirect(`/p/login/verify${next === "/p" ? "" : `?next=${encodeURIComponent(next)}`}` as Route);
}

export async function verifyCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const store = await cookies();
  const requestId = store.get(PARENT_CODE_COOKIE)?.value ?? "";
  let token: string;
  try {
    ({ token } = await verifyParentCode(db(), requestId, formData.get("code"), await getClientInfo()));
  } catch (error) {
    return toFormError(error);
  }
  store.delete({ name: PARENT_CODE_COOKIE, path: "/p/login" });
  await setParentSessionCookie(token);
  redirect(parentNext(formData.get("next")) as Route);
}
