"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  addCollector,
  cancelPickup,
  endCollector,
  refusePickup,
  releaseStudent,
} from "@/server/visitors/pickup";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Pickup (R4-4 VIS-02). */

const refresh = (slug: string, studentId: string) => {
  revalidatePath(schoolPath(slug, "pickup"));
  revalidatePath(schoolPath(slug, `pickup/${studentId}`));
};

export async function releaseAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { personName } = await releaseStudent(db(), ctx, studentId, Object.fromEntries(formData));
    refresh(slug, studentId);
    return { status: "success", message: `Released to ${personName}.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function refuseAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await refusePickup(db(), ctx, studentId, Object.fromEntries(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug, studentId);
  return { status: "success", message: "Refusal recorded." };
}

export async function cancelPickupAction(
  slug: string,
  studentId: string,
  pickupId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelPickup(db(), ctx, pickupId, formData.get("reason"));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug, studentId);
  return { status: "success", message: "Cancelled." };
}

export async function addCollectorAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("photo");
  const photo =
    file instanceof File && file.size > 0
      ? { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) }
      : null;
  const fields = Object.fromEntries([...formData.entries()].filter(([k]) => k !== "photo"));
  try {
    await addCollector(db(), ctx, studentId, fields, photo);
  } catch (error) {
    const state = toFormError(error, formData);
    // A refused photo is reported against the photo field.
    if (state.fieldErrors?.file) state.fieldErrors = { ...state.fieldErrors, photo: state.fieldErrors.file };
    return state;
  }
  refresh(slug, studentId);
  return { status: "success", message: "Added." };
}

export async function endCollectorAction(
  slug: string,
  studentId: string,
  collectorId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await endCollector(db(), ctx, collectorId, formData.get("reason"));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug, studentId);
  return { status: "success", message: "Ended." };
}
