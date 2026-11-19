"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  removeStudentDocument,
  removeStudentPhoto,
  saveStudentMedical,
  setGuardianFlags,
  setStudentPhoto,
  uploadStudentDocument,
} from "@/server/students/profile";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

async function fileFrom(formData: FormData): Promise<{ filename: string; bytes: Buffer }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { filename: "", bytes: Buffer.alloc(0) };
  return { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}

async function run(
  slug: string,
  studentId: string,
  fn: () => Promise<unknown>,
  message: string,
  formData?: FormData,
) {
  try {
    await fn();
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  return { status: "success", message } satisfies FormState;
}

export async function uploadPhotoAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    studentId,
    async () => setStudentPhoto(db(), ctx, studentId, await fileFrom(formData)),
    "Photo saved.",
  );
}

export async function removePhotoAction(slug: string, studentId: string, _prev: FormState) {
  const { ctx } = await requireTenant(slug);
  return run(slug, studentId, () => removeStudentPhoto(db(), ctx, studentId), "Photo removed.");
}

export async function uploadDocumentAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    studentId,
    async () => uploadStudentDocument(db(), ctx, studentId, await fileFrom(formData)),
    "Document added.",
  );
}

export async function removeDocumentAction(
  slug: string,
  studentId: string,
  fileId: string,
  _prev: FormState,
) {
  const { ctx } = await requireTenant(slug);
  return run(slug, studentId, () => removeStudentDocument(db(), ctx, studentId, fileId), "Document removed.");
}

export async function saveMedicalAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    studentId,
    () => saveStudentMedical(db(), ctx, studentId, Object.fromEntries(formData)),
    "Medical information saved.",
    formData,
  );
}

export async function saveGuardianFlagsAction(
  slug: string,
  studentId: string,
  guardianId: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    studentId,
    () =>
      setGuardianFlags(db(), ctx, studentId, guardianId, {
        isFeePayer: formData.get("isFeePayer") === "on",
        isEmergencyContact: formData.get("isEmergencyContact") === "on",
        canPickUp: formData.get("canPickUp") === "on",
        receivesMessages: formData.get("receivesMessages") === "on",
      }),
    "Saved.",
  );
}
