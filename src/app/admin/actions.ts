"use server";

import { revalidatePath } from "next/cache";
import { setSchoolAiLimits } from "@/server/ai/admin";
import {
  invoiceLinesFrom,
  issueSubscriptionInvoice,
  markSubscriptionInvoicePaid,
  updateSubscription,
  voidSubscriptionInvoice,
} from "@/server/billing/subscriptions";
import {
  updateInvoiceDetails,
  updateInvoicingSettings,
  updatePlatformSettings,
} from "@/server/billing/settings";
import { addSmsTopUp, issueAutomaticInvoiceNow } from "@/server/billing/auto-invoices";
import {
  addSuggestedPlans,
  applyPreset,
  createPreset,
  decidePlanRequest,
  setPresetArchived,
  updatePreset,
} from "@/server/billing/plans";
import { db } from "@/server/db/client";
import {
  createSchool,
  reissueOwnerInvitation,
  setSchoolStatus,
  updateEntitlements,
} from "@/server/platform/service";
import { requirePlatformAdmin } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";
import { appOrigin } from "@/web/origin";
import type { InviteLink } from "@/components/ui/invite-link";

export interface InviteResult extends InviteLink {
  schoolId?: string;
  slug?: string;
}

function fields(formData: FormData, names: string[]): Record<string, FormDataEntryValue | null> {
  return Object.fromEntries(names.map((n) => [n, formData.get(n)]));
}

export async function createSchoolAction(
  _prev: FormState<InviteResult>,
  formData: FormData,
): Promise<FormState<InviteResult>> {
  const user = await requirePlatformAdmin();
  const input = fields(formData, [
    "name",
    "slug",
    "countryCode",
    "currencyCode",
    "timezone",
    "ownerEmail",
    "planName",
    "maxCampuses",
    "maxStudents",
    "presetId",
  ]);
  try {
    const created = await createSchool(db(), user.id, input);
    dispatchAfterResponse();
    revalidatePath("/admin");
    return {
      status: "success",
      message: "School created.",
      data: {
        schoolId: created.tenantId,
        slug: created.slug,
        inviteUrl: `${await appOrigin()}/invite/${created.ownerInvitation.token}`,
        email: String(input.ownerEmail).trim().toLowerCase(),
        expiresAt: created.ownerInvitation.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function updateEntitlementsAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateEntitlements(db(), user.id, schoolId, {
      ...fields(formData, ["planName", "maxCampuses", "maxStudents", "maxSmsPerMonth"]),
      features: formData.getAll("features").map(String),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  return { status: "success", message: "Plan updated." };
}

export async function setSchoolStatusAction(
  schoolId: string,
  status: "active" | "suspended",
  _prev: FormState,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setSchoolStatus(db(), user.id, schoolId, status === "suspended" ? "suspended" : "active");
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  revalidatePath("/admin");
  return { status: "success", message: status === "suspended" ? "School suspended." : "School reactivated." };
}

export async function reissueInvitationAction(
  schoolId: string,
  _prev: FormState<InviteResult>,
  formData: FormData,
): Promise<FormState<InviteResult>> {
  const user = await requirePlatformAdmin();
  const email = String(formData.get("email") ?? "");
  try {
    const invitation = await reissueOwnerInvitation(db(), user.id, schoolId, email);
    dispatchAfterResponse();
    revalidatePath(`/admin/schools/${schoolId}`);
    return {
      status: "success",
      message: "New invitation link created. Earlier links no longer work.",
      data: {
        inviteUrl: `${await appOrigin()}/invite/${invitation.token}`,
        email: email.trim().toLowerCase(),
        expiresAt: invitation.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function updateSubscriptionAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateSubscription(
      db(),
      user.id,
      schoolId,
      fields(formData, [
        "status",
        "billingPeriod",
        "trialEndsOn",
        "paidUntil",
        "price",
        "smsPrice",
        "settlementAccount",
        "mobileMoneyProvider",
        "notes",
        "discountPercent",
        "discountLabel",
        "discountUntil",
      ]),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  revalidatePath("/admin/billing");
  return { status: "success", message: "Subscription saved." };
}

export async function issueInvoiceAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    const { invoiceNumber } = await issueSubscriptionInvoice(db(), user.id, schoolId, {
      ...fields(formData, ["periodStartsOn", "periodEndsOn", "dueOn"]),
      lines: invoiceLinesFrom(formData),
    });
    dispatchAfterResponse();
    revalidatePath(`/admin/schools/${schoolId}`);
    revalidatePath("/admin/billing");
    return { status: "success", message: `Invoice ${invoiceNumber} issued and the Proprietors emailed.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function markInvoicePaidAction(
  schoolId: string,
  invoiceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await markSubscriptionInvoicePaid(
      db(),
      user.id,
      schoolId,
      invoiceId,
      fields(formData, ["paidOn", "reference"]),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  revalidatePath("/admin/billing");
  return { status: "success", message: "Payment recorded." };
}

export async function voidInvoiceAction(
  schoolId: string,
  invoiceId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await voidSubscriptionInvoice(db(), user.id, schoolId, invoiceId, fields(formData, ["reason"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  revalidatePath("/admin/billing");
  return { status: "success", message: "Invoice voided." };
}

export async function updatePlatformSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updatePlatformSettings(db(), user.id, fields(formData, ["smsPrice", "whatsappPrice", "graceDays"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: "Billing settings saved." };
}

export async function updateInvoiceDetailsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateInvoiceDetails(db(), user.id, fields(formData, ["issuer", "paymentInstructions"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/admin/billing");
  return { status: "success", message: "Invoice details saved. New and old invoices print them." };
}

function presetInput(formData: FormData) {
  return {
    ...fields(formData, [
      "name",
      "description",
      "maxCampuses",
      "maxStudents",
      "maxSmsPerMonth",
      "billingPeriod",
      "currencyCode",
      "price",
      "band0",
      "band1",
      "band2",
      "band3",
    ]),
    features: formData.getAll("features").map(String),
  };
}

export async function createPresetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await createPreset(db(), user.id, presetInput(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/admin/plans");
  return { status: "success", message: "Plan added." };
}

export async function updatePresetAction(
  presetId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updatePreset(db(), user.id, presetId, presetInput(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/admin/plans");
  return { status: "success", message: "Plan saved. Schools already on it keep their plan." };
}

export async function archivePresetAction(
  presetId: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setPresetArchived(db(), user.id, presetId, archived);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath("/admin/plans");
  return { status: "success", message: archived ? "Plan archived." : "Plan offered again." };
}

export async function applyPresetAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await applyPreset(db(), user.id, schoolId, formData.get("presetId"));
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  return { status: "success", message: "Plan set from the preset." };
}

export async function decidePlanRequestAction(
  requestId: string,
  approve: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    const { applied } = await decidePlanRequest(db(), user.id, requestId, {
      approve,
      note: formData.get("note"),
    });
    dispatchAfterResponse();
    revalidatePath("/admin/plans");
    revalidatePath("/admin", "layout");
    return {
      status: "success",
      message: approve
        ? applied
          ? "Approved: the school's plan now comes from the preset."
          : "Approved. Make the change on the school's page if you have not yet."
        : "Declined. The school was told.",
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

/** A school's own AI allowance (R5-4); empty fields keep the platform default. */
export async function setSchoolAiLimitsAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setSchoolAiLimits(db(), user.id, schoolId, {
      monthlyTokens: formData.get("monthlyTokens"),
      userPerHour: formData.get("userPerHour"),
      userDailyTokens: formData.get("userDailyTokens"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  return { status: "success", message: "AI allowance saved." };
}

/** Adds Starter, Standard and Premium and the add-ons' termly prices (founder, 2026-11-18). */
export async function addSuggestedPlansAction(_prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    const added = await addSuggestedPlans(db(), user.id);
    revalidatePath("/admin/plans");
    revalidatePath("/admin/modules");
    return {
      status: "success",
      message:
        added.plans || added.prices
          ? `Added ${added.plans} plans and ${added.prices} add-on prices. Change any price here or on Modules.`
          : "The suggested plans and add-on prices are already there.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

/** Automatic invoices: on or off, census day, days to pay, yearly discount and monthly surcharge. */
export async function updateInvoicingSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateInvoicingSettings(
      db(),
      user.id,
      fields(formData, [
        "autoInvoicing",
        "censusDays",
        "invoiceDueDays",
        "annualDiscount",
        "monthlySurcharge",
      ]),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/admin/billing");
  return { status: "success", message: "Invoicing settings saved." };
}

/** Issues one school's invoice for its current period now (census taken now if needed). */
export async function issueAutomaticInvoiceNowAction(schoolId: string, _prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    const { invoiceNumber } = await issueAutomaticInvoiceNow(db(), user.id, schoolId);
    dispatchAfterResponse();
    revalidatePath(`/admin/schools/${schoolId}`);
    return { status: "success", message: `Invoice ${invoiceNumber} issued and the Proprietors emailed.` };
  } catch (error) {
    return toFormError(error);
  }
}

/** Adds extra SMS for this month for a school, charged on its next invoice. */
export async function addSmsTopUpAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await addSmsTopUp(db(), user.id, schoolId, {
      messages: formData.get("messages"),
      price: formData.get("price"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(`/admin/schools/${schoolId}`);
  return { status: "success", message: "SMS added for this month. They are charged on the next invoice." };
}
