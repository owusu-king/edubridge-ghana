"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { clearLesson, copyTimetable, removePeriod, savePeriod, setLesson } from "@/server/timetable/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

function done(slug: string, message: string): FormState {
  revalidatePath(schoolPath(slug, "timetable"), "layout");
  revalidatePath(schoolPath(slug, "attendance"), "layout");
  revalidatePath(schoolPath(slug), "page");
  return { status: "success", message };
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

export async function savePeriodAction(
  slug: string,
  periodId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await savePeriod(db(), ctx, {
      ...(periodId ? { id: periodId } : {}),
      name: text(formData, "name"),
      startsAt: text(formData, "startsAt"),
      endsAt: text(formData, "endsAt"),
      kind: text(formData, "kind"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Saved.");
}

export async function removePeriodAction(
  slug: string,
  periodId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await removePeriod(db(), ctx, periodId);
  } catch (error) {
    return toFormError(error);
  }
  return done(slug, "Removed.");
}

export async function setLessonAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const slot = {
    termId: text(formData, "termId"),
    classId: text(formData, "classId"),
    weekday: text(formData, "weekday"),
    periodId: text(formData, "periodId"),
  };
  try {
    if (formData.get("intent") === "clear") await clearLesson(db(), ctx, slot);
    else
      await setLesson(db(), ctx, {
        ...slot,
        subjectId: text(formData, "subjectId"),
        membershipId: text(formData, "membershipId"),
      });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, formData.get("intent") === "clear" ? "Lesson cleared." : "Lesson saved.");
}

export async function copyTimetableAction(
  slug: string,
  toTermId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await copyTimetable(db(), ctx, { fromTermId: text(formData, "fromTermId"), toTermId });
    if (result.lessons === 0)
      return {
        status: "success",
        message: "Nothing was copied: every class already has lessons this term, or the other term has none.",
      };
    revalidatePath(schoolPath(slug, "timetable"), "layout");
    return {
      status: "success",
      message: `Copied ${result.lessons} ${result.lessons === 1 ? "lesson" : "lessons"} into ${result.classes} ${result.classes === 1 ? "class" : "classes"}.${result.skipped ? ` ${result.skipped} left out because the teacher was already teaching then.` : ""}`,
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}
