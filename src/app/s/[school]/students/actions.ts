"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { addGuardianSchema } from "@/server/students/guardians";
import { assignClass, createStudent, setStudentStatus, updateStudent } from "@/server/students/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { fieldErrorState, toFormError, type FormState } from "@/web/forms";

const fields = (formData: FormData) => ({
  firstName: formData.get("firstName"),
  otherNames: formData.get("otherNames"),
  lastName: formData.get("lastName"),
  sex: formData.get("sex"),
  dateOfBirth: formData.get("dateOfBirth"),
  admissionNumber: formData.get("admissionNumber"),
});

/** Guardian fields use their own names so their errors show next to the right inputs. */
function guardianFromForm(formData: FormData): { guardian?: unknown; errors?: Record<string, string> } {
  const name = String(formData.get("guardianFullName") ?? "").trim();
  const phone = String(formData.get("guardianPhone") ?? "").trim();
  if (!name && !phone) return {};
  const input = {
    fullName: name,
    phone,
    relationship: formData.get("guardianRelationship"),
    isPrimary: true,
  };
  const parsed = addGuardianSchema.safeParse(input);
  if (parsed.success) return { guardian: input };
  const keys: Record<string, string> = {
    fullName: "guardianFullName",
    phone: "guardianPhone",
    relationship: "guardianRelationship",
  };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = keys[String(issue.path[0])];
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { errors };
}

export async function addStudentAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const { guardian, errors } = guardianFromForm(formData);
  if (errors) return fieldErrorState(errors, formData);
  try {
    const created = await createStudent(db(), ctx, {
      ...fields(formData),
      classId: formData.get("classId"),
      guardian,
    });
    revalidatePath(schoolPath(slug, "students"));
    return { status: "success", message: `Student added with admission number ${created.admissionNumber}.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

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
  status: "active" | "withdrawn" | "graduated",
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setStudentStatus(db(), ctx, studentId, status);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message: "Status updated." };
}
