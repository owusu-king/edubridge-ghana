"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  checkParentMobileMoneyRequest,
  requestParentFamilyPayment,
  requestParentMobileMoneyPayment,
} from "@/server/mobile-money/requests";
import { requireParent } from "@/web/parent-auth";
import { toFormError, type FormState } from "@/web/forms";

/** A parent sends a Mobile Money prompt to pay a child's fees (PAY-01). */
export async function payOnlineAction(
  slug: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    const outcome = await requestParentMobileMoneyPayment(db(), phone, slug, {
      studentId,
      amount: formData.get("amount") ?? "",
      phone: formData.get("phone") ?? "",
      network: formData.get("network") ?? "",
      idempotencyKey: formData.get("idempotencyKey") ?? "",
    });
    revalidatePath(`/p/${slug}/${studentId}`);
    return {
      status: "success",
      message: outcome.unconfirmed
        ? "We could not confirm the prompt was sent. Check below in a minute before trying again."
        : "Approve the payment on your phone with your Mobile Money PIN. The receipt appears here once the network confirms it.",
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

/** One prompt for several children (2026-11-18): each child's amount comes as shares.<n>.studentId and .amount. */
export async function payFamilyAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { phone } = await requireParent();
  const shares: { studentId: string; amount: string }[] = [];
  for (let i = 0; i < 20; i++) {
    const studentId = formData.get(`shares.${i}.studentId`);
    if (typeof studentId !== "string") break;
    const amount = formData.get(`shares.${i}.amount`);
    shares.push({ studentId, amount: typeof amount === "string" ? amount : "" });
  }
  try {
    const outcome = await requestParentFamilyPayment(db(), phone, slug, {
      shares,
      phone: formData.get("phone") ?? "",
      network: formData.get("network") ?? "",
      idempotencyKey: formData.get("idempotencyKey") ?? "",
    });
    revalidatePath("/p");
    for (const s of shares) revalidatePath(`/p/${slug}/${s.studentId}`);
    return {
      status: "success",
      message: outcome.unconfirmed
        ? "We could not confirm the prompt was sent. Check on a child's page in a minute before trying again."
        : "Approve the payment on your phone with your Mobile Money PIN. Each child's receipt appears on their page once the network confirms it.",
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

const CHECK_MESSAGES: Record<string, string> = {
  pending: "Still waiting for you to approve it on your phone.",
  expired: "Not approved in time. If money left your wallet, it will still be recorded.",
  successful: "Paid. Your receipt is ready.",
  failed: "This payment did not go through. No money was taken.",
  needs_review: "The school is checking this payment. You do not need to pay again.",
};

export async function checkPaymentAction(
  slug: string,
  studentId: string,
  requestId: string,
  _prev: FormState,
): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    const outcome = await checkParentMobileMoneyRequest(db(), phone, slug, requestId);
    if (!outcome) return { status: "error", message: "Payment not found." };
    revalidatePath(`/p/${slug}/${studentId}`);
    return { status: "success", message: CHECK_MESSAGES[outcome.status] ?? "" };
  } catch (error) {
    return toFormError(error);
  }
}
