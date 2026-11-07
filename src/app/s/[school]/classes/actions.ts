"use server";

import { revalidatePath } from "next/cache";
import {
  createClass,
  createLevel,
  renameLevel,
  setClassStatus,
  setupDefaultLevels,
  updateClass,
} from "@/server/academics/classes";
import { setCurrentTerm } from "@/server/academics/calendar";
import { moveStudents, undoMove } from "@/server/academics/term-move";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

async function run(
  slug: string,
  formData: FormData | null,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>["ctx"]) => Promise<unknown>,
  message: string,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await fn(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "classes"));
  return { status: "success", message };
}

export async function setupLevelsAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => setupDefaultLevels(db(), ctx, { stages: formData.getAll("stages").map(String) }),
    "Levels created.",
  );
}

export async function addLevelAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => createLevel(db(), ctx, { name: formData.get("name"), stage: formData.get("stage") }),
    "Level added.",
  );
}

export async function renameLevelAction(slug: string, levelId: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => renameLevel(db(), ctx, levelId, { name: formData.get("name") }),
    "Level renamed.",
  );
}

export async function addClassAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) =>
      createClass(db(), ctx, {
        levelId: formData.get("levelId"),
        campusId: formData.get("campusId"),
        name: formData.get("name"),
        classTeacherMembershipId: formData.get("classTeacherMembershipId"),
      }),
    "Class added.",
  );
}

export async function updateClassAction(slug: string, classId: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) =>
      updateClass(db(), ctx, classId, {
        name: formData.get("name"),
        classTeacherMembershipId: formData.get("classTeacherMembershipId"),
      }),
    "Class updated.",
  );
}

export async function setClassStatusAction(
  slug: string,
  classId: string,
  status: "active" | "archived",
  _prev: FormState,
) {
  return run(
    slug,
    null,
    (ctx) => setClassStatus(db(), ctx, classId, status === "archived" ? "archived" : "active"),
    "Class updated.",
  );
}

export async function moveStudentsAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const destinations: Record<string, string> = {};
  for (const [key, value] of formData.entries())
    if (key.startsWith("dest:") && typeof value === "string") destinations[key.slice(5)] = value;
  try {
    const result = await moveStudents(db(), ctx, {
      fromTermId: String(formData.get("fromTermId") ?? ""),
      toTermId: String(formData.get("toTermId") ?? ""),
      destinations,
      leaveOut: formData.getAll("keepBack").map(String),
    });
    revalidatePath(schoolPath(slug, "classes"));
    revalidatePath(schoolPath(slug));
    const parts = [
      `${result.placed} ${result.placed === 1 ? "student" : "students"} placed in classes`,
      result.graduated ? `${result.graduated} graduated` : "",
      result.leftOut.length ? `${result.leftOut.length} kept back to place by hand` : "",
      result.alreadyPlaced.length
        ? `${result.alreadyPlaced.length} already had a class and were left as they are`
        : "",
    ].filter(Boolean);
    return { status: "success", message: `${parts.join("; ")}.` };
  } catch (error) {
    return toFormError(error);
  }
}

export async function undoMoveAction(slug: string, moveId: string): Promise<FormState> {
  const result = await run(slug, null, (ctx) => undoMove(db(), ctx, moveId), "Move undone.");
  revalidatePath(schoolPath(slug), "layout");
  return result;
}

export async function makeTermCurrentAction(slug: string, termId: string): Promise<FormState> {
  const result = await run(slug, null, (ctx) => setCurrentTerm(db(), ctx, termId), "Current term changed.");
  revalidatePath(schoolPath(slug), "layout");
  return result;
}
