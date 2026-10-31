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
