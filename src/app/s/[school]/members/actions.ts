"use server";

import { revalidatePath } from "next/cache";
import type { InviteLink } from "@/components/ui/invite-link";
import { db } from "@/server/db/client";
import {
  inviteMember,
  reissueInvitation,
  revokeInvitation,
  setMemberStatus,
  updateMember,
} from "@/server/members/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";
import { appOrigin } from "@/web/origin";

/** Roles and campus scope from the shared access fields. */
function accessFields(formData: FormData) {
  return {
    roles: formData.getAll("roles").map(String),
    campusIds: formData.get("campusScope") === "some" ? formData.getAll("campusIds").map(String) : null,
  };
}

const refresh = (slug: string) => revalidatePath(schoolPath(slug, "members"));

export async function inviteMemberAction(
  slug: string,
  _prev: FormState<InviteLink>,
  formData: FormData,
): Promise<FormState<InviteLink>> {
  const { ctx } = await requireTenant(slug);
  try {
    const email = String(formData.get("email") ?? "");
    const issued = await inviteMember(db(), ctx, { email, ...accessFields(formData) });
    dispatchAfterResponse();
    refresh(slug);
    return {
      status: "success",
      message: "Invitation created.",
      data: {
        inviteUrl: `${await appOrigin()}/invite/${issued.token}`,
        email: email.trim().toLowerCase(),
        expiresAt: issued.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function updateMemberAction(
  slug: string,
  membershipId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await updateMember(db(), ctx, membershipId, accessFields(formData));
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug);
  return { status: "success", message: "Access updated." };
}

export async function setMemberStatusAction(
  slug: string,
  membershipId: string,
  status: "active" | "suspended",
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setMemberStatus(db(), ctx, membershipId, status === "suspended" ? "suspended" : "active");
  } catch (error) {
    return toFormError(error);
  }
  refresh(slug);
  return { status: "success", message: status === "suspended" ? "Member suspended." : "Member reactivated." };
}

export async function revokeInvitationAction(
  slug: string,
  invitationId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await revokeInvitation(db(), ctx, invitationId);
  } catch (error) {
    return toFormError(error);
  }
  refresh(slug);
  return { status: "success", message: "Invitation revoked." };
}

export async function reissueInvitationAction(
  slug: string,
  invitationId: string,
  _prev: FormState<InviteLink>,
): Promise<FormState<InviteLink>> {
  const { ctx } = await requireTenant(slug);
  try {
    const issued = await reissueInvitation(db(), ctx, invitationId);
    dispatchAfterResponse();
    refresh(slug);
    return {
      status: "success",
      message: "New link created. The previous link no longer works.",
      data: {
        inviteUrl: `${await appOrigin()}/invite/${issued.token}`,
        email: issued.email,
        expiresAt: issued.expiresAt.toISOString(),
      },
    };
  } catch (error) {
    return toFormError(error);
  }
}
