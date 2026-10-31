"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { reverseEntry } from "@/server/fees/ledger";
import { addConcession, endConcession } from "@/server/fees/concessions";
import { recordAdjustment, setOpeningBalance } from "@/server/fees/opening-balances";
import { cancelPaymentPlan, createPaymentPlan } from "@/server/fees/payment-plans";
import { recordPayment } from "@/server/fees/payments";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function reverseEntryAction(
  slug: string,
  studentId: string,
  entryId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await reverseEntry(db(), ctx, entryId, { reason: formData.get("reason") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  return { status: "success", message: "Entry reversed." };
}

/** Records a payment and opens its receipt. */
export async function recordPaymentAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let paymentId: string;
  try {
    ({ paymentId } = await recordPayment(db(), ctx, {
      studentId,
      amount: formData.get("amount") ?? "",
      method: formData.get("method"),
      reference: formData.get("reference") ?? undefined,
      payerName: formData.get("payerName") ?? undefined,
      paidOn: formData.get("paidOn"),
      idempotencyKey: formData.get("idempotencyKey"),
    }));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  redirect(schoolPath(slug, `fees/receipts/${paymentId}`));
}

async function runForStudent(
  slug: string,
  studentId: string,
  formData: FormData,
  fn: (ctx: Awaited<ReturnType<typeof requireTenant>>["ctx"]) => Promise<unknown>,
  message: string,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await fn(ctx);
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, `students/${studentId}`));
  return { status: "success", message };
}

export async function recordAdjustmentAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    formData,
    (ctx) =>
      recordAdjustment(db(), ctx, studentId, {
        direction: formData.get("direction"),
        amount: formData.get("amount") ?? "",
        description: formData.get("description"),
      }),
    "Added to the account.",
  );
}

export async function setOpeningBalanceAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    formData,
    (ctx) =>
      setOpeningBalance(db(), ctx, studentId, {
        amount: formData.get("amount") ?? "",
        asOf: formData.get("asOf"),
      }),
    "Opening balance recorded.",
  );
}

export async function addConcessionAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    formData,
    (ctx) =>
      addConcession(db(), ctx, studentId, {
        label: formData.get("label"),
        feeItemId: formData.get("feeItemId") ?? "",
        kind: formData.get("kind"),
        value: formData.get("value") ?? "",
      }),
    "Discount added. It applies when the term is next billed.",
  );
}

export async function endConcessionAction(
  slug: string,
  studentId: string,
  concessionId: string,
  _prev: FormState,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    new FormData(),
    (ctx) => endConcession(db(), ctx, concessionId),
    "Discount ended.",
  );
}

export async function createPaymentPlanAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    formData,
    (ctx) =>
      createPaymentPlan(db(), ctx, studentId, {
        total: formData.get("total") ?? "",
        count: formData.get("count"),
        firstDueOn: formData.get("firstDueOn"),
        frequency: formData.get("frequency"),
      }),
    "Payment plan agreed.",
  );
}

export async function cancelPaymentPlanAction(
  slug: string,
  studentId: string,
  planId: string,
  _prev: FormState,
): Promise<FormState> {
  return runForStudent(
    slug,
    studentId,
    new FormData(),
    (ctx) => cancelPaymentPlan(db(), ctx, planId),
    "Plan cancelled.",
  );
}
