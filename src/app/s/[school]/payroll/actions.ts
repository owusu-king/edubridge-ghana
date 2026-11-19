"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import {
  addAdjustment,
  addPayComponent,
  addSuggestedComponents,
  approvePayroll,
  cancelAdjustment,
  cancelPayroll,
  preparePayroll,
  setPayComponentArchived,
  setSalary,
} from "@/server/payroll/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Payroll records (R4-2). */

const base = (slug: string) => schoolPath(slug, "payroll");

export async function preparePayrollAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let runId: string;
  try {
    ({ runId } = await preparePayroll(db(), ctx, { month: formData.get("month") }));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(base(slug), "layout");
  redirect(`${base(slug)}/${runId}` as Route);
}

export async function recalculatePayrollAction(
  slug: string,
  month: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { lines, withoutSalary } = await preparePayroll(db(), ctx, { month });
    revalidatePath(base(slug), "layout");
    return {
      status: "success",
      message: `Recalculated for ${lines} ${lines === 1 ? "person" : "people"}${withoutSalary.length ? `; ${withoutSalary.length} without a salary` : ""}.`,
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function approvePayrollAction(
  slug: string,
  runId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await approvePayroll(db(), ctx, runId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(base(slug), "layout");
  return { status: "success", message: "Approved. This month is now locked." };
}

export async function cancelPayrollAction(slug: string, runId: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelPayroll(db(), ctx, runId);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(base(slug), "layout");
  redirect(base(slug) as Route);
}

export async function setSalaryAction(
  slug: string,
  staffId: string,
  componentIds: string[],
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setSalary(db(), ctx, staffId, {
      effectiveMonth: formData.get("effectiveMonth"),
      basic: formData.get("basic"),
      note: formData.get("note"),
      components: componentIds.map((id) => ({
        componentId: id,
        value: String(formData.get(`component-${id}`) ?? ""),
      })),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(base(slug), "layout");
  return { status: "success", message: "Salary saved." };
}

export async function addAdjustmentAction(
  slug: string,
  staffId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await addAdjustment(db(), ctx, {
      staffId,
      month: formData.get("month"),
      kind: formData.get("kind"),
      description: formData.get("description"),
      amount: formData.get("amount"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(base(slug), "layout");
  return { status: "success", message: "Adjustment added." };
}

export async function cancelAdjustmentAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelAdjustment(db(), ctx, id);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(base(slug), "layout");
  return { status: "success", message: "Cancelled." };
}

export async function addPayComponentAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await addPayComponent(db(), ctx, {
      name: formData.get("name"),
      kind: formData.get("kind"),
      basis: formData.get("basis"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`${base(slug)}/components`);
  return { status: "success", message: "Component added." };
}

export async function addSuggestedComponentsAction(slug: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const added = await addSuggestedComponents(db(), ctx);
    revalidatePath(`${base(slug)}/components`);
    return {
      status: "success",
      message: added ? `${added} components added.` : "The school has them all already.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setPayComponentArchivedAction(
  slug: string,
  id: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setPayComponentArchived(db(), ctx, id, archived);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(`${base(slug)}/components`);
  return { status: "success", message: archived ? "Archived." : "Restored." };
}
