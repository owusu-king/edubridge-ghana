"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createApplication,
  enrolApplicant,
  makeOffer,
  moveApplication,
  recordAssessment,
  updateApplication,
} from "@/server/admissions/service";
import { db } from "@/server/db/client";
import { saveAdmissionFees, saveOnlineApplications } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const values = (formData: FormData) => Object.fromEntries(formData.entries()) as Record<string, string>;

function done(slug: string, message: string, id?: string): FormState {
  revalidatePath(schoolPath(slug, "admissions"), "layout");
  if (id) revalidatePath(schoolPath(slug, `admissions/${id}`));
  return { status: "success", message };
}

export async function createApplicationAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  let id: string;
  try {
    ({ id } = await createApplication(db(), ctx, values(formData)));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "admissions"), "layout");
  redirect(schoolPath(slug, `admissions/${id}`) as Route);
}

export async function updateApplicationAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  try {
    await updateApplication(db(), ctx, id, values(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Saved.", id);
}

export async function moveApplicationAction(
  slug: string,
  id: string,
  to: "applied" | "declined" | "withdrawn",
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  try {
    await moveApplication(db(), ctx, id, { to, note: formData.get("note") ?? undefined });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Saved.", id);
}

export async function recordAssessmentAction(slug: string, id: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  try {
    await recordAssessment(db(), ctx, id, values(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Assessment saved.", id);
}

export async function makeOfferAction(slug: string, id: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  try {
    await makeOffer(db(), ctx, id, values(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Offer made. Print the offer letter for the family.", id);
}

export async function enrolAction(slug: string, id: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  let studentId: string;
  try {
    ({ studentId } = await enrolApplicant(db(), ctx, id, values(formData)));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  redirect(schoolPath(slug, `students/${studentId}`) as Route);
}

export async function saveOnlineApplicationsAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  try {
    await saveOnlineApplications(db(), ctx, { onlineApplications: formData.get("onlineApplications") });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Saved.");
}

export async function saveAdmissionFeesAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  const descriptions = formData.getAll("description").map(String);
  const amounts = formData.getAll("amount").map(String);
  const fees = descriptions
    .map((description, i) => ({ description, amount: amounts[i] ?? "" }))
    .filter((f) => f.description.trim() || f.amount.trim());
  try {
    await saveAdmissionFees(db(), ctx, { fees });
  } catch (error) {
    return toFormError(error, formData);
  }
  return done(slug, "Admission fees saved. Offers made from now on include them.");
}
