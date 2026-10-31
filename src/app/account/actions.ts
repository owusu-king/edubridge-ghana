"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { changePassword, signOutOtherSessions, updateProfile } from "@/server/auth/account";
import { beginEnrollment, confirmEnrollment, disableMfa, regenerateRecoveryCodes } from "@/server/auth/mfa";
import { db } from "@/server/db/client";
import { requireSession } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function updateProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user } = await requireSession();
  try {
    await updateProfile(db(), user.id, { name: formData.get("name") });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath("/", "layout");
  return { status: "success", message: "Profile saved." };
}

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user, sessionId } = await requireSession();
  try {
    await changePassword(db(), user.id, sessionId, {
      currentPassword: formData.get("currentPassword"),
      newPassword: formData.get("newPassword"),
    });
  } catch (error) {
    return toFormError(error);
  }
  return { status: "success", message: "Password changed. You have been signed out on other devices." };
}

export async function signOutOthersAction(_prev: FormState): Promise<FormState> {
  const { user, sessionId } = await requireSession();
  const count = await signOutOtherSessions(db(), user.id, sessionId);
  return {
    status: "success",
    message:
      count === 0
        ? "No other sessions were active."
        : `Signed out of ${count} other ${count === 1 ? "session" : "sessions"}.`,
  };
}

export interface EnrollmentData {
  secret: string;
  qrDataUri: string;
}

export async function beginMfaAction(_prev: FormState<EnrollmentData>): Promise<FormState<EnrollmentData>> {
  const { user } = await requireSession();
  try {
    const { secret, uri } = await beginEnrollment(db(), user);
    const svg = await QRCode.toString(uri, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#1b1a17", light: "#ffffff" },
    });
    return {
      status: "success",
      data: { secret, qrDataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function confirmMfaAction(
  _prev: FormState<string[]>,
  formData: FormData,
): Promise<FormState<string[]>> {
  const { user } = await requireSession();
  try {
    const codes = await confirmEnrollment(db(), user.id, String(formData.get("code") ?? ""));
    // No revalidation here: the page would swap to the "on" state before the recovery codes are shown.
    // The client refreshes once the user confirms they have saved them.
    return { status: "success", message: "Two-step verification is on.", data: codes };
  } catch (error) {
    return toFormError(error);
  }
}

export async function regenerateCodesAction(
  _prev: FormState<string[]>,
  formData: FormData,
): Promise<FormState<string[]>> {
  const { user } = await requireSession();
  try {
    const codes = await regenerateRecoveryCodes(db(), user.id, String(formData.get("code") ?? ""));
    revalidatePath("/account/security");
    return {
      status: "success",
      message: "New recovery codes created. Old codes no longer work.",
      data: codes,
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function disableMfaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { user } = await requireSession();
  try {
    await disableMfa(
      db(),
      user.id,
      String(formData.get("password") ?? ""),
      String(formData.get("code") ?? ""),
    );
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath("/account/security");
  return { status: "success", message: "Two-step verification is off." };
}
