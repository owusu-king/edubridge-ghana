"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { demoSchoolSlug, startDemoVisit } from "@/server/demo/visit";
import { submitEnquiry } from "@/server/enquiries/service";
import { schoolPath } from "@/lib/routes";
import { getClientInfo, getCurrentUser, setSessionCookie } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** The landing page's two actions (2026-11-19): asking for a visit, and opening the demo school. */

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

export async function requestVisitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  // A field people never see: forms that fill it in are robots, and are thanked without anything being kept.
  if (text(formData, "website")) return { status: "success", message: "Thank you." };
  try {
    const { ipAddress } = await getClientInfo();
    await submitEnquiry(
      db(),
      {
        name: text(formData, "name"),
        role: text(formData, "role"),
        schoolName: text(formData, "schoolName"),
        town: text(formData, "town"),
        phone: text(formData, "phone"),
        email: text(formData, "email"),
        students: text(formData, "students"),
        message: text(formData, "message"),
      },
      { ipAddress },
    );
    return { status: "success", message: "Thank you. We will be in touch soon to arrange your demo." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function startDemoAction(_prev: FormState): Promise<FormState> {
  const slug = demoSchoolSlug();
  if (!slug) return { status: "error", message: "The demo school is not available at the moment." };
  const user = await getCurrentUser();
  // Someone already signed in keeps their own session: a demo never replaces it.
  if (user && !user.demoVisitor) redirect("/");
  if (user?.demoVisitor) redirect(schoolPath(slug));
  let target: Route;
  try {
    const visit = await startDemoVisit(db(), slug, await getClientInfo());
    await setSessionCookie(visit.token);
    target = schoolPath(visit.slug);
  } catch (error) {
    return toFormError(error);
  }
  redirect(target);
}
