"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { setAnnouncementSms } from "@/server/parents/preferences";
import { removePushSubscription, savePushSubscription } from "@/server/parents/push";
import { setWhatsAppChoice } from "@/server/parents/whatsapp";
import { requireParent, signOutParent } from "@/web/parent-auth";
import { toFormError, type FormState } from "@/web/forms";

export async function signOutParentAction(): Promise<void> {
  await signOutParent();
  redirect("/p/login" as Route);
}

/** A parent turns a school's announcement SMS on or off (PAR-05). */
export async function setAnnouncementSmsAction(
  slug: string,
  on: boolean,
  _prev: FormState,
): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    await setAnnouncementSms(db(), phone, slug, { on });
    revalidatePath(`/p/${slug}/news`);
    return {
      status: "success",
      message: on
        ? "Announcements will come by SMS."
        : "No more announcement SMS. You can still read them here.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

type PushAnswer = { ok: true } | { ok: false; message: string };

/** This phone turns notifications on (PSH-01): the subscription belongs to the current sign-in. */
export async function savePushAction(subscription: unknown): Promise<PushAnswer> {
  const session = await requireParent();
  try {
    await savePushSubscription(db(), session, subscription);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFormError(error).message ?? "Notifications could not be turned on." };
  }
}

export async function removePushAction(endpoint: string): Promise<PushAnswer> {
  const session = await requireParent();
  await removePushSubscription(db(), session, endpoint);
  return { ok: true };
}

/** The family turns WhatsApp messages on or off for their number (WAB-01). */
export async function setWhatsAppAction(on: boolean, _prev: FormState): Promise<FormState> {
  const { phone } = await requireParent();
  try {
    await setWhatsAppChoice(db(), phone, { on });
    revalidatePath("/p");
    return {
      status: "success",
      message: on ? "Messages will come on WhatsApp." : "WhatsApp messages stopped. Messages come by SMS.",
    };
  } catch (error) {
    return toFormError(error);
  }
}
