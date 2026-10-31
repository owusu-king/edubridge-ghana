"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  createSchool,
  reissueOwnerInvitation,
  setSchoolStatus,
  updateEntitlements,
} from "@/server/platform/service";
import { requirePlatformAdmin } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
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
  ]);
  try {
    const created = await createSchool(db(), user.id, input);
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
    await updateEntitlements(
      db(),
      user.id,
      schoolId,
      fields(formData, ["planName", "maxCampuses", "maxStudents"]),
    );
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
