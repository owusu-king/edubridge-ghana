"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { signInVisitor, signOutVisitor } from "@/server/visitors/visits";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Visitors (R4-4 VIS-01). */

export async function signInVisitorAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await signInVisitor(db(), ctx, Object.fromEntries(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "visitors"));
  return { status: "success", message: "Signed in." };
}

export async function signOutVisitorAction(
  slug: string,
  visitId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await signOutVisitor(db(), ctx, visitId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "visitors"));
  return { status: "success", message: "Signed out." };
}
