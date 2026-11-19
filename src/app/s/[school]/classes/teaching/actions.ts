"use server";

import { revalidatePath } from "next/cache";
import { assignSubjectTeacher, removeSubjectTeacher } from "@/server/assessment/teaching";
import { db } from "@/server/db/client";
import { saveTeachingModel } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

function done(slug: string, message: string): FormState {
  revalidatePath(schoolPath(slug, "classes"), "layout");
  revalidatePath(schoolPath(slug, "assessment"), "layout");
  return { status: "success", message };
}

export async function saveTeachingModelAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  try {
    await saveTeachingModel(db(), ctx, { teachingModel: formData.get("teachingModel") });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Saved.");
}

export async function assignSubjectTeacherAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  try {
    const { assigned } = await assignSubjectTeacher(db(), ctx, {
      membershipId: formData.get("membershipId"),
      subjectId: formData.get("subjectId"),
      classIds: formData.getAll("classIds").map(String),
    });
    return done(slug, `Assigned in ${assigned} ${assigned === 1 ? "class" : "classes"}.`);
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function removeSubjectTeacherAction(slug: string, assignmentId: string, _prev: FormState) {
  const { ctx } = await requireTenant(slug);
  try {
    await removeSubjectTeacher(db(), ctx, assignmentId);
  } catch (error) {
    return toFormError(error);
  }
  return done(slug, "Removed.");
}
