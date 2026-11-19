"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { saveStaffDay, type StaffConflict } from "@/server/staff/attendance";
import {
  addSuggestedLeaveTypes,
  requestLeave,
  saveLeaveType,
  setLeaveTypeArchived,
} from "@/server/staff/leave";
import {
  addStaffListItem,
  changeEmployment,
  createStaff,
  linkStaffMember,
  removeStaffDocument,
  setStaffListItemArchived,
  updateStaffDetails,
  uploadStaffDocument,
  type StaffListKind,
} from "@/server/staff/records";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Staff and HR (R4-1): records, lists, leave types, documents and staff attendance. */

const DETAIL_FIELDS = [
  "firstName",
  "lastName",
  "otherNames",
  "sex",
  "dateOfBirth",
  "phone",
  "email",
  "address",
  "qualifications",
  "emergencyName",
  "emergencyRelationship",
  "emergencyPhone",
];
const EMPLOYMENT_FIELDS = ["employmentType", "departmentId", "positionId", "campusId"];

const fields = (formData: FormData, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, formData.get(n) ?? undefined]));

export async function createStaffAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let id: string;
  try {
    id = await createStaff(
      db(),
      ctx,
      fields(formData, [...DETAIL_FIELDS, ...EMPLOYMENT_FIELDS, "startedOn"]),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "staff"));
  redirect(`${schoolPath(slug, "staff")}/${id}` as Route);
}

export async function updateStaffDetailsAction(
  slug: string,
  staffId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await updateStaffDetails(db(), ctx, staffId, fields(formData, DETAIL_FIELDS));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  return { status: "success", message: "Details saved." };
}

export async function changeEmploymentAction(
  slug: string,
  staffId: string,
  kind: "changed" | "left" | "returned",
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await changeEmployment(db(), ctx, staffId, {
      kind,
      ...fields(formData, [...EMPLOYMENT_FIELDS, "effectiveOn", "note"]),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  revalidatePath(schoolPath(slug, "staff"));
  return { status: "success", message: "Employment updated." };
}

export async function linkStaffMemberAction(
  slug: string,
  staffId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await linkStaffMember(db(), ctx, staffId, { membershipId: formData.get("membershipId") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  return { status: "success", message: "Saved." };
}

export async function uploadStaffDocumentAction(
  slug: string,
  staffId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { status: "error", message: "Choose a file.", fieldErrors: { file: "Choose a file." } };
  try {
    await uploadStaffDocument(db(), ctx, staffId, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  return { status: "success", message: "Document added." };
}

export async function removeStaffDocumentAction(
  slug: string,
  staffId: string,
  fileId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await removeStaffDocument(db(), ctx, staffId, fileId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  return { status: "success", message: "Document removed." };
}

export async function recordLeaveAction(
  slug: string,
  staffId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await requestLeave(db(), ctx, {
      staffId,
      ...fields(formData, ["leaveTypeId", "startsOn", "endsOn", "reason"]),
      confirmOverBalance: formData.get("confirmOverBalance") === "on",
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`${schoolPath(slug, "staff")}/${staffId}`);
  revalidatePath(schoolPath(slug, "leave"));
  return { status: "success", message: "Leave recorded." };
}

// ——— Lists and leave types (Staff, Settings) ———

export async function addStaffListItemAction(
  slug: string,
  kind: StaffListKind,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await addStaffListItem(db(), ctx, kind, { name: formData.get("name") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "staff/settings"));
  return { status: "success", message: "Added." };
}

export async function setStaffListItemArchivedAction(
  slug: string,
  kind: StaffListKind,
  id: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setStaffListItemArchived(db(), ctx, kind, id, archived);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "staff/settings"));
  return { status: "success", message: archived ? "Archived." : "Restored." };
}

export async function saveLeaveTypeAction(
  slug: string,
  id: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveLeaveType(db(), ctx, id, {
      name: formData.get("name"),
      daysPerYear: formData.get("daysPerYear"),
      paid: formData.get("paid") === "on",
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "staff/settings"));
  return { status: "success", message: "Leave type saved." };
}

export async function setLeaveTypeArchivedAction(
  slug: string,
  id: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setLeaveTypeArchived(db(), ctx, id, archived);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "staff/settings"));
  return { status: "success", message: archived ? "Archived." : "Restored." };
}

export async function addSuggestedLeaveTypesAction(slug: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const added = await addSuggestedLeaveTypes(db(), ctx);
    revalidatePath(schoolPath(slug, "staff/settings"));
    return {
      status: "success",
      message: added ? `${added} leave types added.` : "The school has them all already.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

// ——— Staff attendance (HR-04) ———

export interface StaffDaySaved {
  saved: number;
  conflicts: StaffConflict[];
}

export async function saveStaffDayAction(
  slug: string,
  date: string,
  marks: { staffId: string; status: string; note: string; version: number }[],
): Promise<FormState<StaffDaySaved>> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await saveStaffDay(db(), ctx, { date, marks });
    revalidatePath(schoolPath(slug, "staff/attendance"));
    return {
      status: "success",
      message: result.conflicts.length
        ? `${result.saved} saved. ${result.conflicts.length} changed meanwhile: check them below.`
        : `${result.saved} saved.`,
      data: result,
    };
  } catch (error) {
    return toFormError(error);
  }
}
