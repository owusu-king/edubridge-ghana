"use server";

import { revalidatePath } from "next/cache";
import { createCampus, renameCampus, setCampusStatus } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const done = (slug: string, message: string): FormState => {
  revalidatePath(schoolPath(slug, "settings/campuses"));
  return { status: "success", message };
};

export async function addCampusAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const campus = await createCampus(db(), ctx, { name: String(formData.get("name") ?? "") });
    return done(slug, `${campus.name} added.`);
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function renameCampusAction(
  slug: string,
  campusId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await renameCampus(db(), ctx, campusId, { name: String(formData.get("name") ?? "") });
    return done(slug, "Campus renamed.");
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function setCampusStatusAction(
  slug: string,
  campusId: string,
  status: "active" | "archived",
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setCampusStatus(db(), ctx, campusId, status === "archived" ? "archived" : "active");
    return done(slug, status === "archived" ? "Campus archived." : "Campus restored.");
  } catch (error) {
    return toFormError(error);
  }
}
