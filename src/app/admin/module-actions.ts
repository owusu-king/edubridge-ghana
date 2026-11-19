"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  archiveCatalogPrice,
  endModuleGrant,
  grantModule,
  scheduleModuleEnd,
  setCatalogPrice,
  setReadOnlyDays,
  setReleaseAccess,
} from "@/server/entitlements/admin";
import { requirePlatformAdmin } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Platform staff: a school's modules beyond its plan, release access and catalogue prices (ADR 0003). */

const fields = (formData: FormData, names: string[]) =>
  Object.fromEntries(names.map((n) => [n, formData.get(n)]));

function refresh(schoolId?: string) {
  if (schoolId) revalidatePath(`/admin/schools/${schoolId}`);
  revalidatePath("/admin/modules");
}

export async function grantModuleAction(
  schoolId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await grantModule(
      db(),
      user.id,
      schoolId,
      fields(formData, [
        "module",
        "source",
        "startsOn",
        "endsOn",
        "price",
        "priceUnit",
        "billingPeriod",
        "note",
      ]),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(schoolId);
  return { status: "success", message: "Module added for the school." };
}

export async function scheduleModuleEndAction(
  schoolId: string,
  grantId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await scheduleModuleEnd(db(), user.id, schoolId, grantId, fields(formData, ["endsOn"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(schoolId);
  return { status: "success", message: "End date set." };
}

export async function endModuleAction(
  schoolId: string,
  grantId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await endModuleGrant(db(), user.id, schoolId, grantId, fields(formData, ["reason"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(schoolId);
  return { status: "success", message: "Ended. The school's records are kept." };
}

export async function setReleaseAccessAction(
  schoolId: string,
  module: string,
  on: boolean,
  _prev: FormState,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setReleaseAccess(db(), user.id, schoolId, { module, on });
  } catch (error) {
    return toFormError(error);
  }
  refresh(schoolId);
  return { status: "success", message: on ? "Release access given." : "Release access ended." };
}

export async function setCatalogPriceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  // "For" names a plan ("plan:<id>") or a module ("module:<id>").
  const [kind, target] = String(formData.get("for") ?? "").split(":");
  try {
    await setCatalogPrice(db(), user.id, {
      ...fields(formData, ["billingPeriod", "currencyCode", "price", "unit"]),
      presetId: kind === "plan" ? target : null,
      module: kind === "module" ? target : null,
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh();
  revalidatePath("/admin/plans");
  return { status: "success", message: "Price saved. The price it replaces is kept in the history." };
}

export async function archiveCatalogPriceAction(priceId: string, _prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await archiveCatalogPrice(db(), user.id, priceId);
  } catch (error) {
    return toFormError(error);
  }
  refresh();
  revalidatePath("/admin/plans");
  return { status: "success", message: "Price removed from the catalogue." };
}

export async function setReadOnlyDaysAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setReadOnlyDays(db(), user.id, fields(formData, ["days"]));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh();
  return { status: "success", message: "Saved." };
}
