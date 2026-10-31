"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { addGuardian, setPrimaryGuardian, unlinkGuardian, updateGuardian } from "@/server/students/guardians";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const contact = (formData: FormData) => ({
  fullName: formData.get("fullName"),
  phone: formData.get("phone"),
  email: formData.get("email"),
});

async function run(
  slug: string,
  formData: FormData | null,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>["ctx"]) => Promise<string | void>,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let message: string | void;
  try {
    message = await fn(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message: message || "Saved." };
}

export async function addGuardianAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(slug, formData, async (ctx) => {
    const result = await addGuardian(db(), ctx, studentId, {
      ...contact(formData),
      relationship: formData.get("relationship"),
      isPrimary: formData.get("isPrimary"),
    });
    return result.linkedExisting
      ? "Linked to the existing guardian with this phone number."
      : "Guardian added.";
  });
}

export async function updateGuardianAction(
  slug: string,
  guardianId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(slug, formData, async (ctx) => {
    await updateGuardian(db(), ctx, guardianId, contact(formData));
  });
}

export async function makePrimaryAction(
  slug: string,
  studentId: string,
  guardianId: string,
  _prev: FormState,
) {
  return run(slug, null, async (ctx) => {
    await setPrimaryGuardian(db(), ctx, studentId, guardianId);
  });
}

export async function unlinkGuardianAction(
  slug: string,
  studentId: string,
  guardianId: string,
  _prev: FormState,
) {
  return run(slug, null, async (ctx) => {
    await unlinkGuardian(db(), ctx, studentId, guardianId);
  });
}
