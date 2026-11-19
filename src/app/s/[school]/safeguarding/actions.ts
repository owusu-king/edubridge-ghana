"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  addCaseEntry,
  appointLead,
  assignCaseLead,
  endLead,
  markActionDone,
  removeCaseDocument,
  reportConcern,
  setCaseStatus,
  uploadCaseDocument,
} from "@/server/safeguarding/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Safeguarding (R4-3). */

const base = (slug: string) => schoolPath(slug, "safeguarding");
const casePath = (slug: string, caseId: string) => `${base(slug)}/${caseId}`;

export async function reportConcernAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { reference } = await reportConcern(db(), ctx, {
      studentId: formData.get("studentId"),
      category: formData.get("category"),
      description: formData.get("description"),
      occurredOn: formData.get("occurredOn"),
      location: formData.get("location"),
      immediateAction: formData.get("immediateAction"),
    });
    revalidatePath(base(slug));
    return {
      status: "success",
      message: `Thank you. Your report ${reference} has gone to the school's safeguarding leads.`,
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function addEntryAction(
  slug: string,
  caseId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await addCaseEntry(db(), ctx, caseId, {
      kind: formData.get("kind"),
      body: formData.get("body"),
      dueOn: formData.get("dueOn"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(casePath(slug, caseId));
  return { status: "success", message: "Recorded." };
}

export async function markActionDoneAction(
  slug: string,
  caseId: string,
  entryId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await markActionDone(db(), ctx, entryId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(casePath(slug, caseId));
  return { status: "success", message: "Done." };
}

export async function setStatusAction(
  slug: string,
  caseId: string,
  status: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setCaseStatus(db(), ctx, caseId, { status, note: formData.get("note") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(casePath(slug, caseId));
  revalidatePath(base(slug));
  return { status: "success", message: "Saved." };
}

export async function assignLeadAction(
  slug: string,
  caseId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await assignCaseLead(db(), ctx, caseId, String(formData.get("membershipId") ?? "") || null);
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(casePath(slug, caseId));
  return { status: "success", message: "Saved." };
}

export async function uploadCaseDocumentAction(
  slug: string,
  caseId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { status: "error", message: "Choose a file.", fieldErrors: { file: "Choose a file." } };
  try {
    await uploadCaseDocument(db(), ctx, caseId, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(casePath(slug, caseId));
  return { status: "success", message: "Document added." };
}

export async function removeCaseDocumentAction(
  slug: string,
  caseId: string,
  documentId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await removeCaseDocument(db(), ctx, caseId, documentId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(casePath(slug, caseId));
  return { status: "success", message: "Removed." };
}

export async function appointLeadAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await appointLead(db(), ctx, String(formData.get("membershipId") ?? ""));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "settings/safeguarding"));
  return { status: "success", message: "Appointed." };
}

export async function endLeadAction(slug: string, leadId: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await endLead(db(), ctx, leadId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(schoolPath(slug, "settings/safeguarding"));
  return { status: "success", message: "Ended. They no longer see any case." };
}
