"use server";

import type { StudentStatus } from "@/lib/students";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import {
  assignClass,
  createStudent,
  createStudentSchema,
  findPossibleDuplicates,
  setStudentStatus,
  updateStudent,
  type PossibleDuplicate,
} from "@/server/students/service";
import { localizePhoneField } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { addGuardianSchema } from "@/server/students/guardian-links";
import { requireTenant } from "@/web/auth";
import { fieldErrorState, toFormError, type FormState } from "@/web/forms";

const fields = (formData: FormData) => ({
  firstName: formData.get("firstName"),
  otherNames: formData.get("otherNames"),
  preferredName: formData.get("preferredName"),
  lastName: formData.get("lastName"),
  sex: formData.get("sex"),
  dateOfBirth: formData.get("dateOfBirth"),
  admissionNumber: formData.get("admissionNumber"),
});

export async function updateStudentAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await updateStudent(db(), ctx, studentId, fields(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message: "Details saved." };
}

export async function assignClassAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await assignClass(db(), ctx, studentId, String(formData.get("classId") ?? ""));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message: "Class updated." };
}

export async function setStudentStatusAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const status = String(formData.get("status") ?? "") as StudentStatus;
  const reason = String(formData.get("reason") ?? "").trim();
  if (status !== "active" && reason.length < 3)
    return { status: "error", message: "Give the reason.", fieldErrors: { reason: "Give the reason." } };
  try {
    await setStudentStatus(db(), ctx, studentId, status, reason || null);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message: "Status updated." };
}

export type RegisterState = FormState<{ duplicates: PossibleDuplicate[] }>;

/**
 * Registers one student from the Add student dialog, with an optional first guardian, then opens their
 * record. A child with the same name (and date of birth, when given) already on record comes back for the
 * person to confirm it is a different child, as on the offline registration page.
 */
export async function registerStudentAction(
  slug: string,
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const { ctx } = await requireTenant(slug);
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  const guardianName = text("guardianFullName");
  const guardianPhone = text("guardianPhone");
  if (guardianName && !guardianPhone)
    return fieldErrorState(
      { guardianPhone: "Enter the guardian's phone number, or leave the guardian empty." },
      formData,
    );
  if (guardianPhone && !guardianName)
    return fieldErrorState(
      { guardianFullName: "Enter the guardian's name, or leave the guardian empty." },
      formData,
    );
  // A number in the school's national form is read in its country, as the service does.
  const guardian = guardianName
    ? localizePhoneField(
        {
          fullName: guardianName,
          phone: guardianPhone,
          relationship: text("guardianRelationship") || "guardian",
        },
        ctx.tenant.countryCode,
      )
    : null;
  // Checked here with the service's own rules, so each problem shows on the guardian field it belongs to.
  if (guardian) {
    const check = addGuardianSchema.safeParse(guardian);
    if (!check.success) {
      const errors: Record<string, string> = {};
      for (const issue of check.error.issues) {
        const key = `guardian${String(issue.path[0] ?? "fullName").replace(/^./, (c) => c.toUpperCase())}`;
        errors[key] ??= issue.message;
      }
      return fieldErrorState(errors, formData);
    }
  }
  const input = { ...fields(formData), classId: formData.get("classId"), ...(guardian ? { guardian } : {}) };
  let created: { id: string };
  try {
    // The form is checked in full first, so a possible duplicate is only raised on a complete form.
    createStudentSchema.parse(input);
    if (formData.get("confirmDuplicate") !== "on") {
      const duplicates = await findPossibleDuplicates(db(), ctx, {
        firstName: text("firstName"),
        lastName: text("lastName"),
        dateOfBirth: text("dateOfBirth") || null,
      });
      if (duplicates.length)
        return {
          ...fieldErrorState({}, formData),
          message: undefined,
          data: { duplicates },
        };
    }
    created = await createStudent(db(), ctx, input);
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  redirect(schoolPath(slug, `students/${created.id}`));
}
