"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { assignClass, createStudent, setStudentStatus, updateStudent } from "@/server/students/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const fields = (formData: FormData) => ({
  firstName: formData.get("firstName"),
  otherNames: formData.get("otherNames"),
  lastName: formData.get("lastName"),
  sex: formData.get("sex"),
  dateOfBirth: formData.get("dateOfBirth"),
  admissionNumber: formData.get("admissionNumber"),
});

export async function addStudentAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const created = await createStudent(db(), ctx, { ...fields(formData), classId: formData.get("classId") });
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
