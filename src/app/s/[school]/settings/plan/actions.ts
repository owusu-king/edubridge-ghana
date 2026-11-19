"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { invoicePaymentsFromEnv, startInvoicePayment } from "@/server/billing/online-payments";
import { appOrigin } from "@/web/origin";
import { requestPlanChange, withdrawPlanRequest } from "@/server/billing/plans";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";

/** The Proprietor asks EduBridge to change the plan (SUB-02). */
export async function requestPlanChangeAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await requestPlanChange(db(), ctx, {
      presetId: formData.get("presetId"),
      message: formData.get("message"),
    });
    dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "settings/plan"));
    return { status: "success", message: "Request sent. EduBridge will confirm the change and its price." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

/** The Proprietor asks EduBridge to add a module, or to cancel an add-on (SUB-08). */
export async function requestModuleAction(
  slug: string,
  kind: "add_module" | "cancel_module",
  module: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await requestPlanChange(db(), ctx, { kind, module, message: formData.get("message") });
    dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "settings/plan"));
    return { status: "success", message: "Request sent. EduBridge will confirm it with you." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function withdrawPlanRequestAction(
  slug: string,
  requestId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await withdrawPlanRequest(db(), ctx, requestId);
    revalidatePath(schoolPath(slug, "settings/plan"));
    return { status: "success", message: "Request withdrawn." };
  } catch (error) {
    return toFormError(error);
  }
}

/** Opens the payment page for an EduBridge invoice (SUB-04). */
export async function payInvoiceAction(
  slug: string,
  invoiceId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let url: string;
  try {
    const started = await startInvoicePayment(db(), ctx, invoiceId, {
      provider: invoicePaymentsFromEnv(),
      callbackUrl: `${await appOrigin()}${schoolPath(slug, "settings/plan/paid")}`,
    });
    url = started.authorizationUrl;
  } catch (error) {
    return toFormError(error);
  }
  redirect(url as Route);
}
