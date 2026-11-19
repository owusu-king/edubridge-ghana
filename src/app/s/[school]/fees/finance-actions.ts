"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { approveConcession } from "@/server/fees/concessions";
import { closePeriod, reopenPeriod } from "@/server/fees/period-lock";
import { cancelRefund, decideRefund, payRefund, requestRefund } from "@/server/fees/refunds";
import { setFeeItemDetails, setStudentFeeOption } from "@/server/fees/structure";
import { reviewFinanceCheck } from "@/server/forecasting/checks";
import { reviewDifference } from "@/server/mobile-money/reconciliation";
import { saveDiscountApprovalPolicy } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Server actions for finance controls (closing, refunds, approvals, fee item details, optional items). */

const ok = (slug: string, message: string): FormState => {
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message };
};

async function run(
  slug: string,
  fn: () => Promise<unknown>,
  message: string,
  formData?: FormData,
): Promise<FormState> {
  try {
    await fn();
    return ok(slug, message);
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function closePeriodAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => closePeriod(db(), ctx, { through: formData.get("through") }),
    "The period is closed.",
    formData,
  );
}

export async function reopenPeriodAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => reopenPeriod(db(), ctx, { through: formData.get("through") ?? "", reason: formData.get("reason") }),
    "Reopened.",
    formData,
  );
}

export async function requestRefundAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      requestRefund(db(), ctx, studentId, { amount: formData.get("amount"), reason: formData.get("reason") }),
    "Refund requested. Another finance user approves it, then it is paid out.",
    formData,
  );
}

export async function decideRefundAction(
  slug: string,
  refundId: string,
  approve: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => decideRefund(db(), ctx, refundId, { approve, note: formData.get("note") ?? "" }),
    approve ? "Refund approved." : "Refund rejected.",
    formData,
  );
}

export async function payRefundAction(
  slug: string,
  refundId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      payRefund(db(), ctx, refundId, {
        method: formData.get("method"),
        reference: formData.get("reference") ?? "",
        paidOn: formData.get("paidOn"),
      }),
    "Refund paid and recorded on the account.",
    formData,
  );
}

export async function cancelRefundAction(
  slug: string,
  refundId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => cancelRefund(db(), ctx, refundId), "Refund cancelled.");
}

export async function approveConcessionAction(
  slug: string,
  concessionId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => approveConcession(db(), ctx, concessionId),
    "Discount approved. It applies when the term is billed.",
  );
}

export async function saveDiscountApprovalAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      saveDiscountApprovalPolicy(db(), ctx, {
        percent: formData.get("percent") ?? "",
        amount: formData.get("amount") ?? "",
      }),
    "Saved.",
    formData,
  );
}

export async function saveFeeItemDetailsAction(
  slug: string,
  itemId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      setFeeItemDetails(db(), ctx, itemId, {
        category: formData.get("category"),
        optional: formData.get("optional") === "on",
      }),
    "Saved.",
    formData,
  );
}

export async function setFeeOptionAction(
  slug: string,
  studentId: string,
  feeItemId: string,
  takes: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => setStudentFeeOption(db(), ctx, studentId, { feeItemId, takes }),
    takes ? "Added. It is charged when the term is billed." : "Removed from future billing.",
  );
}

export async function reviewDifferenceAction(
  slug: string,
  itemId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => reviewDifference(db(), ctx, itemId, { note: formData.get("note") ?? "" }),
    "Marked as reviewed.",
    formData,
  );
}

/** Reviews a finance check flag once, with a note (R5-2, FCT-02b). */
export async function reviewFinanceCheckAction(
  slug: string,
  termId: string,
  key: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => reviewFinanceCheck(db(), ctx, { termId, key, note: formData.get("note") ?? "" }),
    "Marked as reviewed.",
    formData,
  );
}
