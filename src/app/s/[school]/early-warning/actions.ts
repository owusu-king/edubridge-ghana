"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { reviewIndicator } from "@/server/early-warning/indicators";
import { addPlanUpdate, closeSupportPlan, openSupportPlan } from "@/server/early-warning/plans";
import { saveRules } from "@/server/early-warning/rules";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Server actions for early warning (R5-3): reviews, support plans and the school's rules. */

const fields = (formData: FormData) =>
  Object.fromEntries([...formData.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")));

async function run(
  slug: string,
  fn: () => Promise<unknown>,
  message: string,
  formData: FormData,
): Promise<FormState> {
  try {
    await fn();
    revalidatePath(schoolPath(slug, "early-warning"), "layout");
    revalidatePath(schoolPath(slug), "page");
    return { status: "success", message };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function reviewIndicatorAction(slug: string, key: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => reviewIndicator(db(), ctx, { ...fields(formData), key }), "Review saved.", formData);
}

export async function openPlanAction(slug: string, studentId: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => openSupportPlan(db(), ctx, { ...fields(formData), studentId }),
    "Support plan opened.",
    formData,
  );
}

export async function addPlanUpdateAction(
  slug: string,
  planId: string,
  _prev: FormState,
  formData: FormData,
) {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => addPlanUpdate(db(), ctx, planId, fields(formData)), "Update added.", formData);
}

export async function closePlanAction(slug: string, planId: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => closeSupportPlan(db(), ctx, planId, fields(formData)), "Plan closed.", formData);
}

export async function saveRulesAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => saveRules(db(), ctx, fields(formData)), "Rules saved.", formData);
}
