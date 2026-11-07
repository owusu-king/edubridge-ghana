"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { importLearnerRecord } from "@/server/passport/records";
import {
  acceptTransfer,
  approveTransfer,
  cancelTransfer,
  declineTransfer,
  requestTransfer,
} from "@/server/passport/transfers";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const done = (slug: string, message: string): FormState => {
  revalidatePath(schoolPath(slug, "students"), "layout");
  return { status: "success", message };
};

export async function requestTransferAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await requestTransfer(db(), ctx, Object.fromEntries(formData));
    return done(
      slug,
      "Request sent. The family confirms it in the parent view; then the other school decides.",
    );
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function approveTransferAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await approveTransfer(db(), ctx, id);
    return done(slug, "Approved. A signed record was sent and the student is marked as transferred.");
  } catch (error) {
    return toFormError(error);
  }
}

export async function declineTransferAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await declineTransfer(db(), ctx, id, { reason: formData.get("reason") });
    return done(slug, "Declined.");
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function acceptTransferAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { admissionNumber } = await acceptTransfer(db(), ctx, id, { classId: formData.get("classId") });
    return done(slug, `Enrolled with admission number ${admissionNumber}.`);
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function cancelTransferAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelTransfer(db(), ctx, id);
    return done(slug, "Request withdrawn.");
  } catch (error) {
    return toFormError(error);
  }
}

export async function importRecordAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  try {
    const text = file instanceof File && file.size > 0 ? await file.text() : "";
    const result = await importLearnerRecord(db(), ctx, { file: text, classId: formData.get("classId") });
    return done(
      slug,
      result.verified
        ? "Imported. The record's signature is valid, so it is marked verified."
        : "Imported as unverified: the file carries no EduBridge signature, so nobody vouches for it.",
    );
  } catch (error) {
    return toFormError(error, formData);
  }
}
